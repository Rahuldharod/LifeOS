import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { httpError } from "../../apps/server/src/http-errors.js";
import { registerNotesList } from "../../apps/server/src/notes-list-route.js";

// #173: the Series view refetches one Note by id (the "disk copy" of a conflict), whatever window of the series it sits in.

const roots: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function serve() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-note-by-id-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nBody words\n");
  const server = Fastify();
  servers.push(server);
  server.setErrorHandler((error, _request, reply) => { const { statusCode, body } = httpError(error); reply.status(statusCode).send(body); });
  registerNotesList(server, application);
  return { server, application, note: workspace.note!, meeting: workspace.meeting };
}

describe("GET /api/v1/notes/:id (#173)", () => {
  it("returns one Note with its body and content hash", async () => {
    const { server, note } = await serve();
    const response = await server.inject({ method: "GET", url: `/api/v1/notes/${note.frontmatter.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ frontmatter: { id: note.frontmatter.id }, body: "# Notes\n\nBody words\n", contentHash: note.contentHash });
  });

  it("answers 404 for an unknown id and for an object that is not a Note", async () => {
    const { server, meeting } = await serve();
    expect((await server.inject({ method: "GET", url: "/api/v1/notes/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: `/api/v1/notes/${meeting.frontmatter.id}` })).statusCode).toBe(404);
  });
});
