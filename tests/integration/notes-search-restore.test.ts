import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type AiProvider } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// PB-025: open/deleted note lists, keyword search, and restore.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

// #98: the app proposes Knowledge Notes only with an AI provider; this one keeps the source title.
const titles = new Map<string, string>();
const titled: AiProvider = {
  proposeMeetingOutputs: async () => [],
  proposeKnowledgeNote: async (text) => ({ title: titles.get(text)!, body: `# ${titles.get(text)}\n\n${text.trim()}\n`, confidence: "Medium" })
};

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-notes-search-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), titled, "integration-test");
  await application.rebuildIndex();
  const knowledgeNote = async (title: string, text: string) => {
    titles.set(text, title);
    await application.ingestTextSource(title, text);
    const review = application.reviews().find((item) => item.frontmatter.status === "pending" && item.frontmatter.title === title)!;
    return application.acceptReviewItem(review.frontmatter.id);
  };
  return { root, application, knowledgeNote };
}

const ids = (notes: Array<{ frontmatter: { id: string } }>) => notes.map((note) => note.frontmatter.id);

describe("note search (PB-025)", () => {
  it("matches every word in the title or body, ignoring case and accents", async () => {
    const { application, knowledgeNote } = await setup();
    const roadmap = await knowledgeNote("Réunion produit", "Roadmap priorities for the loyalty programme");
    const pricing = await knowledgeNote("Pricing", "Promotion mechanics and roadmap risks");

    expect(ids(application.searchNotes("reunion"))).toEqual([roadmap.frontmatter.id]);
    expect(ids(application.searchNotes("ROADMAP")).sort()).toEqual(ids([roadmap, pricing]).sort());
    expect(ids(application.searchNotes("roadmap  loyalty"))).toEqual([roadmap.frontmatter.id]);
    expect(application.searchNotes("roadmap unicorn")).toEqual([]);
    // A blank query returns the whole tab.
    expect(application.searchNotes("   ")).toHaveLength(2);
  });

  it("keeps open and deleted notes in separate tabs, each searchable", async () => {
    const { application, knowledgeNote } = await setup();
    const keep = await knowledgeNote("Keep me", "shared keyword alpha");
    const drop = await knowledgeNote("Drop me", "shared keyword beta");
    await application.deleteNote(drop.frontmatter.id, drop.contentHash);

    expect(ids(application.searchNotes("shared"))).toEqual([keep.frontmatter.id]);
    expect(ids(application.searchNotes("shared", "deleted"))).toEqual([drop.frontmatter.id]);
    expect(ids(application.searchNotes("alpha", "deleted"))).toEqual([]);
    expect(ids(application.deletedNotes())).toEqual([drop.frontmatter.id]);
  });
});

describe("note restore (PB-025)", () => {
  it("clears the tombstone, keeps the text, audits it and is idempotent", async () => {
    const { root, application, knowledgeNote } = await setup();
    const note = await knowledgeNote("Mistake", "Deleted by accident");
    const deleted = await application.deleteNote(note.frontmatter.id, note.contentHash);

    const restored = await application.restoreNote(note.frontmatter.id, deleted.contentHash);
    expect(restored.frontmatter.deleted_at).toBeUndefined();
    expect(restored.body).toBe(note.body);
    expect(restored.frontmatter.revision).toBe(deleted.frontmatter.revision + 1);
    expect(ids(application.notes())).toContain(note.frontmatter.id);
    expect(application.deletedNotes()).toEqual([]);
    expect((await readdir(path.join(root, "audit"))).some((file) => file.includes("note-restored"))).toBe(true);

    // A retry with the old hash returns the live note instead of failing.
    await expect(application.restoreNote(note.frontmatter.id, deleted.contentHash)).resolves.toMatchObject({ contentHash: restored.contentHash });
    // The restored note accepts edits again.
    await expect(application.updateBody(note.frontmatter.id, "Edited after restore", restored.contentHash)).resolves.toMatchObject({ body: "Edited after restore" });
  });

  it("refuses to restore a meeting note when the meeting already has a newer one", async () => {
    const { application } = await setup();
    const [event] = await application.listCalendarEvents();
    const first = (await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nFirst\n")).note!;
    const deleted = await application.deleteNote(first.frontmatter.id, first.contentHash);
    const second = (await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nSecond\n")).note!;

    await expect(application.restoreNote(first.frontmatter.id, deleted.contentHash)).rejects.toThrow("already has a newer note");
    expect(ids(application.deletedNotes())).toEqual([first.frontmatter.id]);

    // Deleting the newer note unblocks the restore.
    await application.deleteNote(second.frontmatter.id, second.contentHash);
    await expect(application.restoreNote(first.frontmatter.id, deleted.contentHash)).resolves.toMatchObject({ body: "# Notes\n\nFirst\n" });
    expect((await application.meetingWorkspace(first.frontmatter.meeting_id as string)).note?.frontmatter.id).toBe(first.frontmatter.id);
  });

  it("refuses a stale hash and non-note objects", async () => {
    const { application, knowledgeNote } = await setup();
    const note = await knowledgeNote("Stale", "text");
    const deleted = await application.deleteNote(note.frontmatter.id, note.contentHash);
    await expect(application.restoreNote(note.frontmatter.id, note.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect(ids(application.deletedNotes())).toEqual([deleted.frontmatter.id]);

    const task = await application.createEntity("task", { title: "Not a note" });
    await expect(application.restoreNote(task.frontmatter.id, task.contentHash)).rejects.toThrow("Only notes");
  });
});
