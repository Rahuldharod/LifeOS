import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { acceptLink, createLinkTarget, linkResolutionView, type ApiCall } from "../../apps/web/src/linkResolution.js";
import { labelMap } from "../../apps/web/src/personLabels.js";

// #57: the web card's requests, routed to the application the way apps/server/src/main.ts routes them,
// link the chosen (or newly created) person on the task.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-link-card-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

async function seedPerson(store: MarkdownObjectStore, title: string, email: string) {
  const id = uuidV7();
  const now = "2026-09-01T08:00:00.000Z";
  return store.write({ relativePath: `people/${id}.md`, frontmatter: { id, type: "person", schema_version: 1, revision: 1, title, created_at: now, updated_at: now, updated_by_device: "test", given_name: title.split(" ")[0], identifiers: [{ kind: "email", value: email }] } as unknown as LifeOSObject["frontmatter"], body: `# ${title}\n` });
}

async function dropDraft(root: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", "link.md");
  await mkdir(path.dirname(target), { recursive: true });
  const yaml = Object.entries({ lifeos_draft: 1, kind: "task", draft_key: "link.md", origin: "user-dictated", title: "Send the sizing deck", captured_at: "2026-10-04T09:15:00+02:00", status: "Waiting", ...fields })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(target, `---\n${yaml}\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

/** The two server routes the card calls, with the same body handling as apps/server/src/main.ts. */
const serverFor = (application: LifeOSApplication): ApiCall => async <T>(url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  const accept = url.match(/^\/api\/v1\/review-items\/([^/]+)\/accept$/);
  if (accept && init?.method === "POST") return await application.acceptReviewItem(accept[1]!, { linkTo: typeof body?.linkTo === "string" ? body.linkTo : undefined }) as T;
  const create = url.match(/^\/api\/v1\/entities\/(person|project|client|product)$/);
  if (create && init?.method === "POST") return await application.createEntity(create[1] as "person", (body as { fields: Record<string, unknown> }).fields) as T;
  throw new Error(`Unexpected request ${init?.method} ${url}`);
};

async function adoptWithLinkReview(application: LifeOSApplication) {
  await application.adoptDrafts();
  const task = (await application.listObjects()).find((object) => object.frontmatter.type === "task")!;
  const review = (await application.reviews()).find((item) => item.frontmatter.review_type === "link-resolution")!;
  return { task, review };
}

describe("link-resolution card → accept with linkTo", () => {
  it("GIVEN two matching people WHEN the user picks the external one and accepts THEN the task links to them", async () => {
    const { root, store, application } = await vault();
    await application.saveInternalDomains(["example.com"]);
    const martin = await seedPerson(store, "Joel Martin", "joel.martin@example.com");
    const durand = await seedPerson(store, "Joël Durand", "joel@example.org");
    await application.rebuildIndex();
    await dropDraft(root, { waiting_for: "Joel" });
    const { task, review } = await adoptWithLinkReview(application);

    const view = linkResolutionView(review, labelMap(await application.personLabels()));
    expect(view.reference).toBe("Joel");
    // Each candidate by display label; only the external person carries the " - ext" marker.
    const picked = view.options.find((option) => option.id === durand.frontmatter.id)!;
    expect(picked.suffix).toBe(" - ext");
    expect(view.options.find((option) => option.id === martin.frontmatter.id)).toEqual({ id: martin.frontmatter.id, name: "Joel Martin" });

    await acceptLink(serverFor(application), review.frontmatter.id, picked.id);
    const linked = (await application.listObjects()).find((object) => object.frontmatter.id === task.frontmatter.id)!;
    expect(linked.frontmatter.waiting_for_person_id).toBe(durand.frontmatter.id);
    expect((await application.reviews()).find((item) => item.frontmatter.id === review.frontmatter.id)!.frontmatter).toMatchObject({ status: "accepted", chosen_object_id: durand.frontmatter.id });
  });

  it("GIVEN no match WHEN the user creates the person THEN the new person is linked", async () => {
    const { root, application } = await vault();
    await dropDraft(root, { waiting_for: "Priya" });
    const { task, review } = await adoptWithLinkReview(application);
    const view = linkResolutionView(review, labelMap([]));
    expect(view).toMatchObject({ options: [], canCreate: true, candidateType: "person" });

    const call = serverFor(application);
    const created = await createLinkTarget(call, view.candidateType, view.reference);
    await acceptLink(call, review.frontmatter.id, created.id);
    const linked = (await application.listObjects()).find((object) => object.frontmatter.id === task.frontmatter.id)!;
    expect(linked.frontmatter.waiting_for_person_id).toBe(created.id);
    expect(created.name).toBe("Priya");
  });

  it("surfaces the server's error when nothing is chosen", async () => {
    const { root, store, application } = await vault();
    await seedPerson(store, "Joel Martin", "joel.martin@example.com");
    await seedPerson(store, "Joel Durand", "joel.durand@example.com");
    await application.rebuildIndex();
    await dropDraft(root, { waiting_for: "Joel" });
    const { review } = await adoptWithLinkReview(application);
    await expect(serverFor(application)(`/api/v1/review-items/${review.frontmatter.id}/accept`, { method: "POST" })).rejects.toThrow(/Choose the person to link/);
  });
});
