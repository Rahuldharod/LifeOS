import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { registerDuplicateCleanup } from "../../apps/server/src/duplicate-cleanup-route.js";
import { httpError } from "../../apps/server/src/http-errors.js";

// The Duplicate clean-up over HTTP: list, then back up and apply the ticked rows.

const roots: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function serve(backUp: () => Promise<{ backupId: string } | undefined>) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-cleanup-api-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "integration-test");
  await application.rebuildIndex();
  const a = await application.createEntity("person", { title: "Sam Lee", given_name: "Sam", family_name: "Lee" });
  const b = await application.createEntity("person", { title: "Sam Lee", given_name: "Sam", family_name: "Lee" });
  const server = Fastify();
  servers.push(server);
  server.setErrorHandler((error, _request, reply) => { const { statusCode, body } = httpError(error); reply.status(statusCode).send(body); });
  registerDuplicateCleanup(server, application, backUp);
  return { server, application, a, b };
}

describe("Duplicate clean-up API", () => {
  it("lists the pair, then backs up and merges it", async () => {
    const { server, application } = await serve(async () => ({ backupId: "b1" }));
    const rows = (await server.inject({ method: "GET", url: "/api/v1/people/duplicates" })).json();
    expect(rows).toEqual([expect.objectContaining({ kind: "merge", match: "name", preTicked: false })]);
    const response = await server.inject({ method: "POST", url: "/api/v1/people/duplicates/clean-up", payload: { merges: [{ keepPersonId: rows[0].keepPersonId, mergePersonId: rows[0].mergePersonId }], repairs: [] } });
    expect(response.json()).toEqual({ backupId: "b1", merged: 1, repaired: 0, skipped: 0 });
    expect(application.entities("person")).toHaveLength(1);
  });

  it("refuses a malformed body and changes nothing when the backup does not run", async () => {
    const { server, application, a, b } = await serve(async () => undefined);
    expect((await server.inject({ method: "POST", url: "/api/v1/people/duplicates/clean-up", payload: { merges: "all" } })).statusCode).toBe(400);
    const response = await server.inject({ method: "POST", url: "/api/v1/people/duplicates/clean-up", payload: { merges: [{ keepPersonId: a.frontmatter.id, mergePersonId: b.frontmatter.id }], repairs: [] } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().error).toContain("nothing was changed");
    expect(application.entities("person")).toHaveLength(2);
  });
});
