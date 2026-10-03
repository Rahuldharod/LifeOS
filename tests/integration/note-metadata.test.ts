import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// PB-006: a note's title and relationships change through a use case, never by hand-editing YAML.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-note-metadata-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nBody stays put\n");
  const person = await application.createEntity("person", { title: "Ada Lovelace", given_name: "Ada" });
  const client = await application.createEntity("client", { title: "Example Client" });
  const project = await application.createEntity("project", { title: "Launch" });
  const product = await application.createEntity("product", { title: "LifeOS" });
  return { root, store, application, note: workspace.note!, person, client, project, product };
}

describe("note metadata (PB-006)", () => {
  it("renames and relinks a note, keeping body, file path and unknown front matter", async () => {
    const { root, store, application, note, person, client, project, product } = await setup();
    const updated = await application.updateNoteMetadata(note.frontmatter.id, {
      title: "  Weekly sync, renamed  ",
      primary_project_id: project.frontmatter.id,
      primary_client_id: client.frontmatter.id,
      primary_product_id: product.frontmatter.id,
      people_ids: [person.frontmatter.id, person.frontmatter.id]
    }, note.contentHash);

    expect(updated.frontmatter.title).toBe("Weekly sync, renamed");
    expect(updated.frontmatter.primary_project_id).toBe(project.frontmatter.id);
    expect(updated.frontmatter.people_ids).toEqual([person.frontmatter.id]);
    expect(updated.frontmatter.revision).toBe(note.frontmatter.revision + 1);
    expect(updated.body).toBe(note.body);
    expect(updated.relativePath).toBe(note.relativePath);
    expect(updated.frontmatter.meeting_id).toBe(note.frontmatter.meeting_id);

    const onDisk = await store.read(note.relativePath);
    expect(onDisk.frontmatter.title).toBe("Weekly sync, renamed");
    expect(application.notes().find((candidate) => candidate.frontmatter.id === note.frontmatter.id)?.frontmatter.title).toBe("Weekly sync, renamed");
    expect((await readdir(path.join(root, "audit"))).some((file) => file.includes("note-metadata-updated"))).toBe(true);
  });

  it("clears a link with null and leaves untouched fields alone", async () => {
    const { application, note, project, client } = await setup();
    const linked = await application.updateNoteMetadata(note.frontmatter.id, { primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id }, note.contentHash);
    const cleared = await application.updateNoteMetadata(note.frontmatter.id, { primary_project_id: null }, linked.contentHash);
    expect(cleared.frontmatter.primary_project_id).toBeUndefined();
    expect(cleared.frontmatter.primary_client_id).toBe(client.frontmatter.id);
    expect(cleared.frontmatter.title).toBe(note.frontmatter.title);
  });

  it("writes nothing when nothing changes, so a retry adds no revision", async () => {
    const { application, note } = await setup();
    const same = await application.updateNoteMetadata(note.frontmatter.id, { title: note.frontmatter.title }, note.contentHash);
    expect(same.contentHash).toBe(note.contentHash);
    expect(same.frontmatter.revision).toBe(note.frontmatter.revision);
  });

  it("rejects a blank title, a link to the wrong type, a missing or archived target", async () => {
    const { application, note, person, project } = await setup();
    await expect(application.updateNoteMetadata(note.frontmatter.id, { title: "   " }, note.contentHash)).rejects.toThrow("Title is required");
    await expect(application.updateNoteMetadata(note.frontmatter.id, { primary_project_id: person.frontmatter.id }, note.contentHash)).rejects.toThrow("Project not found");
    await expect(application.updateNoteMetadata(note.frontmatter.id, { primary_client_id: "01995d3e-912b-7357-8aa6-9816c1ad90a5" }, note.contentHash)).rejects.toThrow("Client not found");
    await expect(application.updateNoteMetadata(note.frontmatter.id, { people_ids: [project.frontmatter.id] }, note.contentHash)).rejects.toThrow("Person not found");
    await application.archiveObject(project.frontmatter.id, project.contentHash);
    await expect(application.updateNoteMetadata(note.frontmatter.id, { primary_project_id: project.frontmatter.id }, note.contentHash)).rejects.toThrow("Project not found");
    expect(application.object(note.frontmatter.id).contentHash).toBe(note.contentHash);
  });

  it("refuses a stale hash, a deleted note and non-note objects", async () => {
    const { application, note, project } = await setup();
    const edited = await application.updateBody(note.frontmatter.id, "# Notes\n\nEdited elsewhere\n", note.contentHash);
    await expect(application.updateNoteMetadata(note.frontmatter.id, { title: "Late rename" }, note.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.updateNoteMetadata(project.frontmatter.id, { title: "Nope" }, project.contentHash)).rejects.toThrow("Only notes");
    const deleted = await application.deleteNote(note.frontmatter.id, edited.contentHash);
    await expect(application.updateNoteMetadata(note.frontmatter.id, { title: "Zombie" }, deleted.contentHash)).rejects.toThrow("deleted");
  });

  it("does not let a later body save undo the rename", async () => {
    const { application, note } = await setup();
    const renamed = await application.updateNoteMetadata(note.frontmatter.id, { title: "Renamed" }, note.contentHash);
    const edited = await application.updateBody(note.frontmatter.id, "# Notes\n\nMore text\n", renamed.contentHash);
    expect(edited.frontmatter.title).toBe("Renamed");
  });
});
