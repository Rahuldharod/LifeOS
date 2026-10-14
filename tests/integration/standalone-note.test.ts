import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { testApi } from "./test-api.js";

// PB-034 (#222, ADR 0023): a Standalone Note has no meeting and no source; the browser picks its id up front.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const NOTE_ID = "0190a1b2-0000-7000-8000-0000000000a1";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-standalone-note-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  return { root, store, application };
}

describe("standalone note (PB-034)", () => {
  it("creates one file in notes/ with origin app and an auto title", async () => {
    const { root, store, application } = await setup();
    const created = await application.createStandaloneNote({ id: NOTE_ID, body: "First thoughts\n", timeZone: "Europe/Paris", now: "2026-10-14T12:05:00.000Z" });

    expect(created.frontmatter.type).toBe("standalone-note");
    expect(created.frontmatter.origin).toBe("app");
    expect(created.frontmatter.title).toBe("Note 14 Oct 2026 14:05");
    expect(created.frontmatter.meeting_id).toBeUndefined();
    expect(created.relativePath).toBe(`notes/2026-10-14-1405-note-14-oct-2026-14-05--${NOTE_ID}.md`);
    expect(created.body).toBe("First thoughts\n");
    expect(await readdir(path.join(root, "notes"))).toEqual([path.basename(created.relativePath)]);
    expect((await store.read(created.relativePath)).frontmatter.type).toBe("standalone-note");
    expect(application.notes().map((note) => note.frontmatter.id)).toEqual([NOTE_ID]);
  });

  it("returns the same note when the first edit is retried with the same id", async () => {
    const { root, application } = await setup();
    const first = await application.createStandaloneNote({ id: NOTE_ID, body: "One\n", now: "2026-10-14T12:05:00.000Z" });
    const retry = await application.createStandaloneNote({ id: NOTE_ID, body: "One, retried\n", now: "2026-10-14T12:06:00.000Z" });

    expect(retry.relativePath).toBe(first.relativePath);
    expect(retry.body).toBe("One\n");
    expect(retry.frontmatter.revision).toBe(1);
    expect(await readdir(path.join(root, "notes"))).toHaveLength(1);
  });

  it("applies held title and links in the same write", async () => {
    const { application } = await setup();
    const person = await application.createEntity("person", { title: "Ada Lovelace", given_name: "Ada" });
    const client = await application.createEntity("client", { title: "Example Client" });
    const project = await application.createEntity("project", { title: "Launch" });
    const product = await application.createEntity("product", { title: "LifeOS" });
    const created = await application.createStandaloneNote({
      id: NOTE_ID, body: "Body\n", now: "2026-10-14T12:05:00.000Z",
      title: "  Pricing thoughts  ",
      metadata: { primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id, people_ids: [person.frontmatter.id, person.frontmatter.id], sensitivity: "restricted" }
    });

    expect(created.frontmatter.title).toBe("Pricing thoughts");
    expect(created.frontmatter.primary_project_id).toBe(project.frontmatter.id);
    expect(created.frontmatter.primary_client_id).toBe(client.frontmatter.id);
    expect(created.frontmatter.primary_product_id).toBe(product.frontmatter.id);
    expect(created.frontmatter.people_ids).toEqual([person.frontmatter.id]);
    expect(created.frontmatter.sensitivity).toBe("restricted");
    expect(created.frontmatter.revision).toBe(1);
    expect(created.relativePath).toBe(`notes/2026-10-14-1205-pricing-thoughts--${NOTE_ID}.md`);
  });

  it("rejects a link to a missing object and writes nothing", async () => {
    const { root, application } = await setup();
    await expect(application.createStandaloneNote({ id: NOTE_ID, body: "Body\n", metadata: { primary_project_id: "0190a1b2-0000-7000-8000-0000000000ff" } })).rejects.toThrow("Project not found");
    await expect(readdir(path.join(root, "notes"))).rejects.toThrow();
    expect(application.notes()).toEqual([]);
  });

  it("keeps unknown front matter and body text through an edit round trip", async () => {
    const { root, store, application } = await setup();
    const created = await application.createStandaloneNote({ id: NOTE_ID, body: "# Heading\n\nOriginal\n", now: "2026-10-14T12:05:00.000Z" });
    const absolute = path.join(root, created.relativePath);
    const raw = await readFile(absolute, "utf8");
    await writeFile(absolute, raw.replace("origin: app", "origin: app\ncustom_field: keep me"));
    await application.rebuildIndex();
    const current = application.note(NOTE_ID)!;
    const edited = await application.updateBody(NOTE_ID, "# Heading\n\nChanged\n\n- [ ] item\n", current.contentHash);

    expect(edited.frontmatter.custom_field).toBe("keep me");
    expect((await store.read(created.relativePath)).frontmatter.custom_field).toBe("keep me");
    expect((await store.read(created.relativePath)).body).toBe("# Heading\n\nChanged\n\n- [ ] item\n");
  });

  it("renames without moving the file", async () => {
    const { application } = await setup();
    const created = await application.createStandaloneNote({ id: NOTE_ID, body: "Body\n", now: "2026-10-14T12:05:00.000Z" });
    const renamed = await application.updateNoteMetadata(NOTE_ID, { title: "Renamed note" }, created.contentHash);

    expect(renamed.frontmatter.title).toBe("Renamed note");
    expect(renamed.relativePath).toBe(created.relativePath);
    expect(renamed.frontmatter.title_manually_renamed).toBeUndefined();
  });

  it("deletes, restores and permanently deletes like other notes", async () => {
    const { root, application } = await setup();
    const created = await application.createStandaloneNote({ id: NOTE_ID, body: "Body\n", now: "2026-10-14T12:05:00.000Z" });
    const deleted = await application.deleteNote(NOTE_ID, created.contentHash);
    expect(application.notes()).toEqual([]);
    expect(application.deletedNotes().map((note) => note.frontmatter.id)).toEqual([NOTE_ID]);

    const restored = await application.restoreNote(NOTE_ID, deleted.contentHash);
    expect(restored.frontmatter.deleted_at).toBeUndefined();
    expect(application.notes().map((note) => note.frontmatter.id)).toEqual([NOTE_ID]);

    const again = await application.deleteNote(NOTE_ID, restored.contentHash);
    await application.purgeNote(NOTE_ID, again.contentHash);
    expect(application.note(NOTE_ID)).toBeUndefined();
    expect(await readdir(path.join(root, "notes"))).toEqual([]);
  });

  it("filters the type in searchNotes", async () => {
    const { application } = await setup();
    await application.createStandaloneNote({ id: NOTE_ID, body: "Body\n", now: "2026-10-14T12:05:00.000Z" });
    expect(application.searchNotes("", "open", { types: ["standalone-note"] }).map((note) => note.frontmatter.id)).toEqual([NOTE_ID]);
  });

  it("creates one note through the API even when the same first edit arrives twice at once", async () => {
    const { call, start } = await testApi();
    await start();
    const [first, second] = await Promise.all([
      call("POST /api/v1/notes", { body: { id: NOTE_ID, body: "Typed once\n", timeZone: "Europe/Paris" } }),
      call("POST /api/v1/notes", { body: { id: NOTE_ID, body: "Typed once\n", timeZone: "Europe/Paris" } })
    ]);

    expect(second.relativePath).toBe(first.relativePath);
    expect(first.frontmatter).toMatchObject({ type: "standalone-note", origin: "app" });
    const listed = await call("GET /api/v1/notes", { query: { type: "standalone-note" } });
    expect(listed.map((note) => note.frontmatter.id)).toEqual([NOTE_ID]);
  });
});
