import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type AiProvider } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #105 (PB-005): filters on the Notes list, combined with keyword search, applied in the use case.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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
  return { application, events, meeting, knowledge, ada, bob, client, project, product, id };
}
const ids = (notes: Array<{ frontmatter: { id: string } }>) => notes.map((note) => note.frontmatter.id).sort();

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
    const { application, knowledge } = await setup();
    const open = await knowledge("Open one");
    const gone = await knowledge("Gone one");
    await application.deleteNote(gone.frontmatter.id, gone.contentHash);
    const day = 86_400_000;
    const around = { from: new Date(Date.now() - day).toISOString(), to: new Date(Date.now() + day).toISOString() };

    expect(ids(application.searchNotes("", "open", around))).toEqual(ids([open]));
    expect(ids(application.searchNotes("", "deleted", around))).toEqual(ids([gone]));
    expect(application.searchNotes("", "open", { from: new Date(Date.now() + day).toISOString() })).toEqual([]);
    expect(application.searchNotes("", "deleted", { to: new Date(Date.now() - day).toISOString() })).toEqual([]);
    // The bounds are inclusive.
    const exact = open.frontmatter.updated_at;
    expect(ids(application.searchNotes("", "open", { from: exact, to: exact }))).toEqual(ids([open]));
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
