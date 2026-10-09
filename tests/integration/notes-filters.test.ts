import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type AiProvider } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { httpError } from "../../apps/server/src/http-errors.js";
import { registerNotesList } from "../../apps/server/src/notes-list-route.js";

// #105 (PB-005): filters on the Notes list, combined with keyword search, applied in the use case.

const roots: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const titled: AiProvider = {
  proposeMeetingOutputs: async () => [],
  proposeKnowledgeNote: async (text) => ({ title: text.trim(), body: `# ${text.trim()}\n\n${text.trim()}\n`, confidence: "Medium" })
};

// The stock mock offers one event with client, product and project names; two plain events keep links explicit.
class TwoEvents extends MockCalendarConnector {
  override async listEvents(from: Date, to: Date) {
    const [event] = await super.listEvents(from, to);
    if (!event) return [];
    const plain = { ...event, clientName: "", productName: "", projectName: "" };
    return [{ ...plain, externalId: "event-a", title: "Sync A" }, { ...plain, externalId: "event-b", title: "Sync B" }];
  }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-notes-filters-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new TwoEvents(), titled, "integration-test");
  await application.rebuildIndex();
  const events = await application.listCalendarEvents();
  const meeting = async (index: number, body: string, links: Record<string, unknown>) => {
    const workspace = await application.createMeetingFromEvent(events[index]!.externalId, undefined, undefined, undefined, body);
    return application.updateNoteMetadata(workspace.note!.frontmatter.id, links, workspace.note!.contentHash);
  };
  const knowledge = async (text: string) => {
    await application.ingestTextSource(text, text);
    const review = application.reviews().find((item) => item.frontmatter.status === "pending" && item.frontmatter.title === text)!;
    return application.acceptReviewItem(review.frontmatter.id);
  };
  const ada = await application.createEntity("person", { title: "Ada Lovelace", given_name: "Ada" });
  const bob = await application.createEntity("person", { title: "Bob Example", given_name: "Bob" });
  const client = await application.createEntity("client", { title: "Example Client" });
  const project = await application.createEntity("project", { title: "Launch" });
  const product = await application.createEntity("product", { title: "LifeOS" });
  const id = (object: { frontmatter: { id: string } }) => object.frontmatter.id;
  return { root, application, events, meeting, knowledge, ada, bob, client, project, product, id };
}
const ids = (notes: Array<{ frontmatter: { id: string } }>) => notes.map((note) => note.frontmatter.id).sort();

/** Back-dates front-matter timestamps in a temp-root note file (test setup only; the app never does this). */
async function stamp(root: string, relativePath: string, fields: Record<string, string>) {
  const file = path.join(root, relativePath);
  let text = await readFile(file, "utf8");
  for (const [key, value] of Object.entries(fields)) {
    const line = new RegExp(`^${key}: .*$`, "m");
    expect(text).toMatch(line);
    text = text.replace(line, `${key}: "${value}"`);
  }
  await writeFile(file, text);
}

async function serve() {
  const context = await setup();
  const server = Fastify();
  servers.push(server);
  registerNotesList(server, context.application);
  server.setErrorHandler((error, _request, reply) => { const { statusCode, body } = httpError(error); reply.status(statusCode).send(body); });
  return { ...context, server };
}

describe("notes list filters (#105)", () => {
  it("filters by type (multi-select), each context filter alone, and combined with AND", async () => {
    const { application, events, meeting, knowledge, ada, bob, client, project, product, id } = await setup();
    expect(events.length).toBeGreaterThanOrEqual(2);
    const first = await meeting(0, "# Notes\n\nroadmap alpha\n", { primary_project_id: id(project), primary_client_id: id(client), people_ids: [id(ada)] });
    const second = await meeting(1, "# Notes\n\nroadmap beta\n", { primary_product_id: id(product), people_ids: [id(bob)] });
    const know = await knowledge("Standalone idea roadmap");

    expect(ids(application.searchNotes("", "open", {}))).toEqual(ids([first, second, know]));
    expect(ids(application.searchNotes("", "open", { types: ["knowledge-note"] }))).toEqual(ids([know]));
    expect(ids(application.searchNotes("", "open", { types: ["meeting-note", "knowledge-note"] }))).toEqual(ids([first, second, know]));
    expect(ids(application.searchNotes("", "open", { types: ["meeting-note"] }))).toEqual(ids([first, second]));
    expect(ids(application.searchNotes("", "open", { projectId: id(project) }))).toEqual(ids([first]));
    expect(ids(application.searchNotes("", "open", { clientId: id(client) }))).toEqual(ids([first]));
    expect(ids(application.searchNotes("", "open", { productId: id(product) }))).toEqual(ids([second]));
    expect(ids(application.searchNotes("", "open", { personId: id(bob) }))).toEqual(ids([second]));
    // Two combined: AND.
    expect(ids(application.searchNotes("", "open", { projectId: id(project), personId: id(ada) }))).toEqual(ids([first]));
    expect(application.searchNotes("", "open", { projectId: id(project), personId: id(bob) })).toEqual([]);
    // Keywords apply on top; knowledge notes are excluded by any context filter.
    expect(ids(application.searchNotes("roadmap", "open", { personId: id(ada) }))).toEqual(ids([first]));
    expect(application.searchNotes("beta", "open", { personId: id(ada) })).toEqual([]);
    expect(ids(application.searchNotes("roadmap", "open", { types: ["knowledge-note"] }))).toEqual(ids([know]));
    expect(application.searchNotes("", "open", { types: ["knowledge-note"], projectId: id(project) })).toEqual([]);
  });

  it("filters by day range on updated_at (open) and deleted_at (deleted), both ends inclusive", async () => {
    const { root, application, knowledge } = await setup();
    const open = await knowledge("Open one");
    const gone = await knowledge("Gone one");
    await application.deleteNote(gone.frontmatter.id, gone.contentHash);
    // Put the timestamps on different days so each tab can only pass by reading its own field:
    // both notes last edited on 1 January, the deleted one deleted on 5 January.
    const edited = "2026-01-01T10:00:00.000Z";
    const deleted = "2026-01-05T10:00:00.000Z";
    await stamp(root, open.relativePath, { updated_at: edited });
    await stamp(root, gone.relativePath, { updated_at: edited, deleted_at: deleted });
    await application.rebuildIndex();
    const dayOne = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T23:59:59.999Z" };
    const dayFive = { from: "2026-01-05T00:00:00.000Z", to: "2026-01-05T23:59:59.999Z" };

    expect(ids(application.searchNotes("", "open", dayOne))).toEqual(ids([open]));
    expect(application.searchNotes("", "open", dayFive)).toEqual([]);
    expect(ids(application.searchNotes("", "deleted", dayFive))).toEqual(ids([gone]));
    expect(application.searchNotes("", "deleted", dayOne)).toEqual([]);
    // The bounds are inclusive.
    expect(ids(application.searchNotes("", "open", { from: edited, to: edited }))).toEqual(ids([open]));
    expect(ids(application.searchNotes("", "deleted", { from: deleted, to: deleted }))).toEqual(ids([gone]));
  });

  it("matches a person on the note's own people_ids, not on the meeting's attendees (unlike Decisions #41)", async () => {
    const { application, meeting, ada, id } = await setup();
    // A new meeting note starts with the attendees in people_ids; the user then sets the note's people to Ada only.
    const note = await meeting(0, "# Notes\n\nx\n", { people_ids: [id(ada)] });
    const attendeeIds = application.object(String(note.frontmatter.meeting_id))?.frontmatter.attendee_ids;
    expect(Array.isArray(attendeeIds) && attendeeIds.length).toBeTruthy();
    const attendee = String((attendeeIds as unknown[])[0]);
    expect(note.frontmatter.people_ids).toEqual([id(ada)]);

    expect(application.searchNotes("", "open", { personId: attendee })).toEqual([]);
    expect(ids(application.searchNotes("", "open", { personId: id(ada) }))).toEqual([note.frontmatter.id]);
  });

  it("filters the deleted tab by context too", async () => {
    const { application, meeting, project, id } = await setup();
    const note = await meeting(0, "# Notes\n\nx\n", { primary_project_id: id(project) });
    await application.deleteNote(note.frontmatter.id, note.contentHash);
    expect(ids(application.searchNotes("", "deleted", { projectId: id(project) }))).toEqual([note.frontmatter.id]);
    expect(application.searchNotes("", "open", { projectId: id(project) })).toEqual([]);
  });

  it("rejects an unknown type or an unparseable or reversed date", async () => {
    const { application } = await setup();
    expect(() => application.searchNotes("", "open", { types: ["task"] })).toThrow("Note type must be one of");
    expect(() => application.searchNotes("", "open", { from: "yesterday-ish" })).toThrow("Enter a valid date range");
    expect(() => application.searchNotes("", "open", { to: "nope" })).toThrow("Enter a valid date range");
    expect(() => application.searchNotes("", "open", { from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" })).toThrow("Enter a valid date range");
  });
});

describe("GET /api/v1/notes filters (#105)", () => {
  it("passes repeated type and the link filters through to the use case", async () => {
    const { server, meeting, knowledge, project, id } = await serve();
    const linked = await meeting(0, "# Notes\n\nx\n", { primary_project_id: id(project) });
    const know = await knowledge("Loose idea");

    const both = await server.inject({ method: "GET", url: "/api/v1/notes?type=meeting-note&type=knowledge-note" });
    expect(both.statusCode).toBe(200);
    expect(ids(both.json())).toEqual(ids([linked, know]));
    const one = await server.inject({ method: "GET", url: "/api/v1/notes?type=knowledge-note" });
    expect(ids(one.json())).toEqual(ids([know]));
    const byProject = await server.inject({ method: "GET", url: `/api/v1/notes?projectId=${id(project)}` });
    expect(ids(byProject.json())).toEqual(ids([linked]));
  });

  it("answers 400 with a plain message for an unknown type or an unparseable date", async () => {
    const { server } = await serve();
    const badType = await server.inject({ method: "GET", url: "/api/v1/notes?type=task" });
    expect(badType.statusCode).toBe(400);
    expect(badType.json()).toEqual({ error: "Note type must be one of meeting-note, knowledge-note" });
    const badDate = await server.inject({ method: "GET", url: "/api/v1/notes?state=deleted&from=not-a-date" });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.json()).toEqual({ error: "Enter a valid date range" });
  });
});
