import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { noteSaveRequest, openNoteDraft, reconcileNoteDraft } from "../../apps/web/src/noteDraft.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const noteId = "01995d52-7baf-7c21-9c96-9c5d2f6a32ac";

async function workspaceWithNote() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-note-draft-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  await store.write({
    relativePath: "meetings/note.md",
    frontmatter: { schema_version: 1, revision: 1, id: noteId, type: "meeting-note", title: "Note", created_at: "2026-09-20T08:00:00Z", updated_at: "2026-09-20T09:00:00Z", updated_by_device: "test", meeting_id: "01995d4e-a934-70e5-a5a6-85e31541a91f" },
    body: "Original body\n"
  });
  const application = new LifeOSApplication(store, new MemoryIndex());
  await application.rebuildIndex();
  const openNote = () => application.notes().find((note) => note.frontmatter.id === noteId)!;
  return { application, file: path.join(root, "meetings/note.md"), openNote };
}

// Simulates Obsidian, Google Drive or an agent rewriting the file outside the app.
async function editExternally(file: string) {
  const content = await readFile(file, "utf8");
  await writeFile(file, content.replace("Original body", "Agent edit"), "utf8");
}

describe("Notes draft autosave after an external edit", () => {
  it("raises a conflict instead of overwriting the file when lists were refreshed", async () => {
    const { application, file, openNote } = await workspaceWithNote();
    const opened = openNoteDraft(openNote());
    const draft = `${opened.draft}Browser edit\n`;

    await editExternally(file);
    await application.rebuildIndex(); // file watcher reconcile + loadCollections()
    const refreshed = openNote();
    expect(refreshed.contentHash).not.toBe(opened.base.hash);
    expect(reconcileNoteDraft(opened.base, draft, refreshed)).toEqual({ kind: "conflict" });

    const request = noteSaveRequest(opened.base, draft);
    await expect(application.updateBody(noteId, request.body, request.expectedHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).toContain("Agent edit");
    expect(onDisk).not.toContain("Browser edit");
  });

  it("adopts the external version when the draft has no local edits", async () => {
    const { application, file, openNote } = await workspaceWithNote();
    const opened = openNoteDraft(openNote());

    await editExternally(file);
    await application.rebuildIndex();
    const result = reconcileNoteDraft(opened.base, opened.draft, openNote());
    expect(result).toMatchObject({ kind: "resync", draft: "Agent edit\n", base: { hash: openNote().contentHash } });
  });

  it("keeps a restored browser draft pinned to its cached base hash", async () => {
    const { application, file, openNote } = await workspaceWithNote();
    const baseHash = openNote().contentHash;
    await editExternally(file);
    await application.rebuildIndex();

    const restored = openNoteDraft(openNote(), { body: "Cached browser draft\n", baseHash });
    expect(restored.conflict).toBe(true);
    const request = noteSaveRequest(restored.base, restored.draft);
    await expect(application.updateBody(noteId, request.body, request.expectedHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect(await readFile(file, "utf8")).toContain("Agent edit");
  });
});
