import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { uuidV7 } from "@lifeos/domain";
import type { Api } from "../../apps/web/src/api.js";
import { testApi } from "./test-api.js";

// ADR 0025 over the real routes: `POST /api/v1/review-items/:id/undo`.

function person(title: string, email: string) {
  const id = uuidV7();
  const now = "2026-09-01T08:00:00.000Z";
  const content = `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: ${now}\nupdated_at: ${now}\nupdated_by_device: test\ngiven_name: ${title.split(" ")[0]}\nidentifiers:\n  - kind: email\n    value: ${email}\n---\n# ${title}\n`;
  return { id, file: { [`people/${id}.md`]: content } };
}

/** A link-resolution Review Item: the draft names "Joel", and two people match. */
async function linkReview() {
  const martin = person("Joel Martin", "joel.martin@example.com");
  const durand = person("Joël Durand", "joel@example.org");
  const built = await testApi({ files: { ...martin.file, ...durand.file }, timing: { adoptionDebounceMs: 3_600_000, adoptionSweepMs: 3_600_000 } });
  await built.start();
  const { root, call } = built;
  await call("PUT /api/v1/settings/internal-domains", { body: { domains: ["example.com"] } });
  const target = path.join(root, "_inbox", "drafts", "link.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\nlifeos_draft: 1\nkind: task\ndraft_key: link.md\norigin: user-dictated\ntitle: Send the sizing deck\ncaptured_at: "2026-10-04T09:15:00+02:00"\nstatus: Waiting\nwaiting_for: Joel\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
  await call("POST /api/v1/inbox/adopt");
  const review = (await call("GET /api/v1/review-items")).find((item) => item.frontmatter.review_type === "link-resolution")!;
  return { call, send: built.send, reviewId: review.frontmatter.id, durandId: durand.id, martinId: martin.id };
}

const statusOf = async (call: Api, id: string) => (await call("GET /api/v1/review-items")).find((item) => item.frontmatter.id === id)!.frontmatter.status;

describe("POST /api/v1/review-items/:id/undo", () => {
  it("puts a rejected item back to pending, and a second call changes nothing", async () => {
    const { call, reviewId } = await linkReview();
    await call("POST /api/v1/review-items/:id/reject", { params: { id: reviewId } });
    expect(await statusOf(call, reviewId)).toBe("rejected");

    const undone = await call("POST /api/v1/review-items/:id/undo", { params: { id: reviewId } });
    expect(undone).toMatchObject({ outcome: "undone", review: { frontmatter: { id: reviewId, status: "pending" } } });
    expect(await statusOf(call, reviewId)).toBe("pending");
    expect((await call("POST /api/v1/review-items/:id/undo", { params: { id: reviewId } })).outcome).toBe("already-pending");
  });

  it("takes an accepted link back (200), and answers 409 with the reason once the field was changed since, changing nothing", async () => {
    const { call, send, reviewId, durandId, martinId } = await linkReview();
    const task = async () => (await call("GET /api/v1/objects")).find((object) => object.frontmatter.type === "task")!;
    await call("POST /api/v1/review-items/:id/accept", { params: { id: reviewId }, body: { linkTo: durandId } });
    expect((await task()).frontmatter.waiting_for_person_id).toBe(durandId);
    const undone = await call("POST /api/v1/review-items/:id/undo", { params: { id: reviewId } });
    expect(undone).toMatchObject({ outcome: "undone", revertedObjectIds: [(await task()).frontmatter.id] });
    expect((await task()).frontmatter.waiting_for_person_id).toBeUndefined();

    await call("POST /api/v1/review-items/:id/accept", { params: { id: reviewId }, body: { linkTo: durandId } });
    const linked = await task();
    const edited = await send("PATCH", `/api/v1/entities/by-id/${linked.frontmatter.id}`, { fields: { waiting_for_person_id: martinId }, expectedHash: linked.contentHash });
    expect(edited.statusCode).toBe(200);
    const refused = await send("POST", `/api/v1/review-items/${reviewId}/undo`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: expect.stringMatching(/was changed after the link was accepted/) });
    expect(await statusOf(call, reviewId)).toBe("accepted");
  });

  it("answers 400 for an unknown item", async () => {
    const { send } = await linkReview();
    expect((await send("POST", `/api/v1/review-items/${uuidV7()}/undo`)).statusCode).toBe(400);
  });
});
