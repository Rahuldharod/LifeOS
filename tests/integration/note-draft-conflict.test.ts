import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { isConflictedDraft, noteDraftBase, noteSaveRequest, openNoteDraft, reconcileNoteDraft } from "../../apps/web/src/noteDraft.js";

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

describe("Keep browser version / Keep disk version (PB-002 conflict panel)", () => {
  it("Keep browser version rebases onto the latest disk copy and preserves the overwritten version in history", async () => {
    const { application, file, openNote } = await workspaceWithNote();
    const opened = openNoteDraft(openNote());
    const draft = `${opened.draft}Browser edit\n`;

    await editExternally(file);
    await application.rebuildIndex();
    const latest = openNote(); // stands in for the app's refetch immediately before saving

    const base = noteDraftBase(latest);
    const updated = await application.updateBody(noteId, draft, noteSaveRequest(base, draft).expectedHash);
    expect(updated.body).toBe(draft);
    expect(await readFile(file, "utf8")).toContain(draft);

    const versionsDir = path.join(path.dirname(file), "..", ".lifeos", "versions", noteId);
    const versions = await import("node:fs/promises").then((fs) => fs.readdir(versionsDir));
    const previousVersion = await Promise.all(versions.map((name) => import("node:fs/promises").then((fs) => fs.readFile(path.join(versionsDir, name), "utf8"))));
    expect(previousVersion.some((content) => content.includes("Agent edit"))).toBe(true);
  });

  it("Keep browser version fails as a fresh conflict if the file changed again after the refetch", async () => {
    const { application, file, openNote } = await workspaceWithNote();
    const opened = openNoteDraft(openNote());
    const draft = `${opened.draft}Browser edit\n`;

    await editExternally(file); // first external edit, seen by the refetch below
    await application.rebuildIndex();
    const staleBase = noteDraftBase(openNote());

    // A second, distinct external edit lands after the refetch but before the save. `editExternally`
    // targets a substring the first edit already consumed, so it would be a no-op here — append
    // instead, to guarantee a genuinely different hash rather than accidentally rewriting the same content.
    await writeFile(file, `${await readFile(file, "utf8")}\nA second, later external edit\n`, "utf8");
    await application.rebuildIndex();

    const request = noteSaveRequest(staleBase, draft);
    await expect(application.updateBody(noteId, request.body, request.expectedHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect(await readFile(file, "utf8")).not.toContain("Browser edit");
  });

  it("Keep disk version adopts the file's current content and clears the conflict", async () => {
    const { application, file, openNote } = await workspaceWithNote();
    await editExternally(file);
    await application.rebuildIndex();
    const latest = openNote();

    const cached = { body: "Cached browser draft\n", baseHash: "stale-hash" };
    expect(isConflictedDraft(cached, latest)).toBe(true);

    // "Keep disk version" is a pure discard of the local draft in favour of what's already on
    // disk — no write happens, so nothing above the object store needs asserting beyond this.
    const rebased = noteDraftBase(latest);
    expect(rebased.body).toBe(latest.body);
    expect(isConflictedDraft(undefined, latest)).toBe(false); // cache cleared after adopting disk
  });
});
