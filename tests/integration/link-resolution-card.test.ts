import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { uuidV7 } from "@lifeos/domain";
import { acceptLink, createLinkTarget, linkResolutionView, type ApiCall } from "../../apps/web/src/linkResolution.js";
import { labelMap, type PersonLabel } from "../../apps/web/src/personLabels.js";
import { testApi } from "./test-api.js";

// #57: the web card's requests, sent to the real API routes (#120), link the chosen (or newly created) person on the task.

type Item = { frontmatter: { id: string; type: string; title: string } & Record<string, unknown> };

function person(title: string, email: string) {
  const id = uuidV7();
  const now = "2026-09-01T08:00:00.000Z";
  const content = `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: ${now}\nupdated_at: ${now}\nupdated_by_device: test\ngiven_name: ${title.split(" ")[0]}\nidentifiers:\n  - kind: email\n    value: ${email}\n---\n# ${title}\n`;
  return { id, file: { [`people/${id}.md`]: content } };
}

/** The API with these people, started; background adoption waits an hour, so the test adopts when it chooses. */
async function vault(...people: Array<ReturnType<typeof person>>) {
  const built = await testApi({ files: Object.assign({}, ...people.map((entry) => entry.file)), timing: { adoptionDebounceMs: 3_600_000, adoptionSweepMs: 3_600_000 } });
  await built.start();
  return built;
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

async function adoptWithLinkReview(call: ApiCall) {
  await call("/api/v1/inbox/adopt", { method: "POST" });
  const task = (await call<Item[]>("/api/v1/objects")).find((object) => object.frontmatter.type === "task")!;
  const review = (await call<Item[]>("/api/v1/review-items")).find((item) => item.frontmatter.review_type === "link-resolution")!;
  return { task, review };
}

const object = async (call: ApiCall, id: string) => (await call<Item[]>("/api/v1/objects")).find((entry) => entry.frontmatter.id === id)!;

describe("link-resolution card → accept with linkTo", () => {
  it("GIVEN two matching people WHEN the user picks the external one and accepts THEN the task links to them", async () => {
    const martin = person("Joel Martin", "joel.martin@example.com");
    const durand = person("Joël Durand", "joel@example.org");
    const { root, call } = await vault(martin, durand);
    await call("/api/v1/settings/internal-domains", { method: "PUT", body: JSON.stringify({ domains: ["example.com"] }) });
    await dropDraft(root, { waiting_for: "Joel" });
    const { task, review } = await adoptWithLinkReview(call);

    const view = linkResolutionView(review, labelMap(await call<PersonLabel[]>("/api/v1/people/labels")));
    expect(view.reference).toBe("Joel");
    // Each candidate by display label; only the external person carries the " - ext" marker.
    const picked = view.options.find((option) => option.id === durand.id)!;
    expect(picked.suffix).toBe(" - ext");
    expect(view.options.find((option) => option.id === martin.id)).toEqual({ id: martin.id, name: "Joel Martin" });

    await acceptLink(call, review.frontmatter.id, picked.id);
    expect((await object(call, task.frontmatter.id)).frontmatter.waiting_for_person_id).toBe(durand.id);
    expect((await call<Item[]>("/api/v1/review-items")).find((item) => item.frontmatter.id === review.frontmatter.id)!.frontmatter).toMatchObject({ status: "accepted", chosen_object_id: durand.id });
  });

  it("GIVEN no match WHEN the user creates the person THEN the new person is linked", async () => {
    const { root, call } = await vault();
    await dropDraft(root, { waiting_for: "Priya" });
    const { task, review } = await adoptWithLinkReview(call);
    const view = linkResolutionView(review, labelMap([]));
    expect(view).toMatchObject({ options: [], canCreate: true, candidateType: "person" });

    const created = await createLinkTarget(call, view.candidateType, view.reference);
    await acceptLink(call, review.frontmatter.id, created.id);
    expect((await object(call, task.frontmatter.id)).frontmatter.waiting_for_person_id).toBe(created.id);
    expect(created.name).toBe("Priya");
  });

  it("surfaces the server's error when nothing is chosen", async () => {
    const { root, call } = await vault(person("Joel Martin", "joel.martin@example.com"), person("Joel Durand", "joel.durand@example.com"));
    await dropDraft(root, { waiting_for: "Joel" });
    const { review } = await adoptWithLinkReview(call);
    await expect(call(`/api/v1/review-items/${review.frontmatter.id}/accept`, { method: "POST" })).rejects.toThrow(/Choose the person to link/);
  });
});
