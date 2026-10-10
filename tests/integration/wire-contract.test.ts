import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Api } from "../../apps/web/src/api.js";
import { route } from "../../apps/server/src/route.js";
import { testApi } from "./test-api.js";

// #121: one wire contract (@lifeos/contracts) for the server's routes and the browser's calls.

/**
 * Compile-time checks, never run. Each `@ts-expect-error` marks a deliberate mismatch with the contract; if the
 * mismatch stopped being a type error, `pnpm typecheck` would fail on the unused directive.
 */
export function serverRepliesAreChecked(server: FastifyInstance) {
  // @ts-expect-error a reply field of the wrong type (`patches` is a number)
  route(server, "GET /api/v1/inbox/drafts", async () => ({ awaiting: 1, drafts: 1, patches: "1", failed: [] }));
  // @ts-expect-error a reply without a field the browser reads (`emails`)
  route(server, "GET /api/v1/settings/self-emails", async () => ({ contentHash: "hash" }));
  // @ts-expect-error a route that is not in the contract
  route(server, "GET /api/v1/nowhere", async () => ({}));
  route(server, "POST /api/v1/notes/:id/restore", async (request, reply) => {
    // @ts-expect-error the body's `expectedHash` is text
    const hash: number = request.body.expectedHash;
    // @ts-expect-error the path has `:id`, not `:noteId`
    void request.params.noteId;
    return reply.status(400).send({ error: String(hash) });
  });
}

export async function browserCallsAreChecked(api: Api) {
  const inbox = await api("GET /api/v1/inbox/drafts");
  // @ts-expect-error not a field of the inbox status
  void inbox.waiting;
  // @ts-expect-error the path parameter is required
  await api("GET /api/v1/meetings/:id/workspace");
  // @ts-expect-error a body field of the wrong type
  await api("PUT /api/v1/settings/daily-focus", { body: { maxMustDos: "3" } });
  // @ts-expect-error review edits take only the editable proposal fields (drift reconciled to the server's ReviewEdits)
  await api("PATCH /api/v1/review-items/:id", { params: { id: "review" }, body: { status: "accepted" } });
  // @ts-expect-error a method the endpoint does not have
  await api("DELETE /api/v1/inbox/drafts");
  const batch = await api("POST /api/v1/inbox/adopt");
  const retrySoon: boolean = batch.retrySoon;
  return retrySoon;
}

async function dropTaskDraft(root: string) {
  const target = path.join(root, "_inbox", "drafts", "task.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\nlifeos_draft: 1\nkind: "task"\ndraft_key: "task.md"\norigin: "user-dictated"\ntitle: "Send the sizing deck"\ncaptured_at: "2026-10-04T09:15:00+02:00"\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

describe("the server answers the inbox shapes the contract declares (reconciled drifts)", () => {
  it("GIVEN a waiting draft WHEN the browser reads the inbox and adopts THEN both answers carry the server's fields", async () => {
    const built = await testApi({ timing: { adoptionDebounceMs: 3_600_000, adoptionSweepMs: 3_600_000 } });
    await built.start();
    await dropTaskDraft(built.root);

    const inbox = await built.call("GET /api/v1/inbox/drafts");
    expect(inbox).toEqual({ awaiting: 1, drafts: 1, patches: 0, failed: [] });

    const batch = await built.call("POST /api/v1/inbox/adopt");
    expect(batch.retrySoon).toBe(false);
    expect(batch.drafts).toEqual([expect.objectContaining({ draft: "_inbox/drafts/task.md", outcome: "adopted", objectIds: [expect.any(String)] })]);
  });
});
