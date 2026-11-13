import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type ObjectStore } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { httpError } from "../../apps/server/src/http-errors.js";
import { registerLease } from "../../apps/server/src/lease.js";
import { registerNotePurge } from "../../apps/server/src/note-purge-routes.js";

// PB-030 (#103): a tombstoned note can be deleted permanently from the Deleted tab.

const roots: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exists = (target: string) => access(target).then(() => true, () => false);

async function open(root: string, objects: ObjectStore = new MarkdownObjectStore(root)) {
  const application = new LifeOSApplication(objects, new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  return application;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-note-purge-"));
  roots.push(root);
  const application = await open(root);
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nObsolete\n");
  const note = workspace.note!;
  const tombstone = await application.deleteNote(note.frontmatter.id, note.contentHash);
  return { root, application, note: tombstone, meetingId: workspace.meeting.frontmatter.id };
}

const audits = async (application: LifeOSApplication, action: string, objectId: string) =>
  (await application.listObjects()).filter((object) => object.frontmatter.action === action && object.frontmatter.object_id === objectId);

describe("deleting a note permanently (PB-030)", () => {
  it("GIVEN a deleted note with no references WHEN purged THEN its file and versions are gone, the index and health do not mention it, and an audit names it by id and title only", async () => {
    const { root, application, note } = await setup();
    const id = note.frontmatter.id;
    expect(await exists(path.join(root, ".lifeos", "versions", id))).toBe(true);

    await application.purgeNote(id, note.contentHash);

    expect(await exists(path.join(root, note.relativePath))).toBe(false);
    expect(await exists(path.join(root, ".lifeos", "versions", id))).toBe(false);
    expect(application.deletedNotes().map((candidate) => candidate.frontmatter.id)).not.toContain(id);
    expect(() => application.object(id)).toThrow("not found");
    const health = await application.health();
    expect(health.diagnostics.filter((entry) => entry.includes(id))).toEqual([]);
    const [audit, ...more] = await audits(application, "note.purged", id);
    expect(more).toHaveLength(0);
    expect(audit!.frontmatter.metadata).toMatchObject({ title: note.frontmatter.title });
    expect(JSON.stringify(audit!.frontmatter.metadata)).not.toContain("Obsolete");
    expect(await readFile(path.join(root, audit!.relativePath), "utf8")).not.toContain("Obsolete");
    // The audit outlives the note, and a restart finds nothing left to do.
    const restarted = await open(root);
    expect(await restarted.recoverOperations()).toEqual([]);
    expect(await readdir(path.join(root, ".lifeos", "versions"))).not.toContain(id);
  });

  it("GIVEN a task references the note in its front matter THEN the delete is refused, lists the task, and removes nothing", async () => {
    const { root, application, note } = await setup();
    const id = note.frontmatter.id;
    const listed = await linkFromTask(root, application, "Follow up", { source_ids: [id] });
    const single = await linkFromTask(root, application, "Check figures", { evidence_note_id: id });

    expect(application.notePurgeCheck(id).blockers.map((entry) => entry.id).sort()).toEqual([listed, single].sort());
    const refusal = await application.purgeNote(id, note.contentHash).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ name: "NoteReferencedError" });
    expect((refusal as { references: Array<{ id: string; title: string }> }).references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: listed, title: "Follow up", type: "task" }),
      expect.objectContaining({ id: single, title: "Check figures" })
    ]));
    expect(await exists(path.join(root, note.relativePath))).toBe(true);
    expect(await exists(path.join(root, ".lifeos", "versions", id))).toBe(true);
    expect(await audits(application, "note.purged", id)).toHaveLength(0);
  });

  it("GIVEN only body links point at the note THEN the check lists them as a warning and the delete proceeds", async () => {
    const { root, application, note } = await setup();
    const id = note.frontmatter.id;
    const linking = await linkFromTask(root, application, "Read the old note", {}, `See [old](lifeos://object/${id}).\n`);

    expect(application.notePurgeCheck(id)).toEqual({ blockers: [], bodyLinks: [{ id: linking, type: "task", title: "Read the old note" }] });
    await application.purgeNote(id, note.contentHash);
    expect(await exists(path.join(root, note.relativePath))).toBe(false);
    // The linking task is untouched; its link now points at nothing.
    expect(application.object(linking).body).toContain(`lifeos://object/${id}`);
  });

  it("refuses a stale hash, a missing hash, a note that is not deleted, and a non-note", async () => {
    const { application, note } = await setup();
    const id = note.frontmatter.id;
    const restored = await application.restoreNote(id, note.contentHash);
    await expect(application.purgeNote(id, restored.contentHash)).rejects.toThrow("Only deleted notes");
    const deletedAgain = await application.deleteNote(id, restored.contentHash);
    await expect(application.purgeNote(id, note.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.purgeNote(id, "")).rejects.toThrow("expectedHash");
    const task = await application.createEntity("task", { title: "Not a note" });
    await expect(application.purgeNote(task.frontmatter.id, task.contentHash)).rejects.toThrow("Only notes");
    expect(application.deletedNotes().map((candidate) => candidate.contentHash)).toContain(deletedAgain.contentHash);
  });

  it("GIVEN a double-click THEN the note is purged once with one audit", async () => {
    const { application, note } = await setup();
    const id = note.frontmatter.id;
    const results = await Promise.allSettled([application.purgeNote(id, note.contentHash), application.purgeNote(id, note.contentHash)]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(await audits(application, "note.purged", id)).toHaveLength(1);
  });
});

describe("permanent delete crash recovery (PB-030, ADR 0013)", () => {
  /** The process "dies" right after the note file is removed, before its versions are. */
  function crashAfterFileRemoval(store: MarkdownObjectStore): ObjectStore {
    return new Proxy(store, { get(object, property, receiver) {
      if (property === "removeVersions") return async () => { throw new Error("simulated crash before removing versions"); };
      const value = Reflect.get(object, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    } });
  }

  async function crashMidPurge() {
    const context = await setup();
    const crashing = await open(context.root, crashAfterFileRemoval(new MarkdownObjectStore(context.root)));
    await expect(crashing.purgeNote(context.note.frontmatter.id, context.note.contentHash)).rejects.toThrow("simulated crash");
    expect(await exists(path.join(context.root, context.note.relativePath))).toBe(false);
    expect(await exists(path.join(context.root, ".lifeos", "versions", context.note.frontmatter.id))).toBe(true);
    return context;
  }

  it("GIVEN a crash between removing the file and the versions WHEN the app starts again THEN recovery finishes the job with one audit", async () => {
    const { root, note } = await crashMidPurge();
    const id = note.frontmatter.id;
    const restarted = await open(root);
    expect(await restarted.recoverOperations()).toHaveLength(1);
    expect(await exists(path.join(root, ".lifeos", "versions", id))).toBe(false);
    expect(await audits(restarted, "note.purged", id)).toHaveLength(1);
    expect(await restarted.recoverOperations()).toEqual([]);
    expect((await restarted.health()).diagnostics.filter((entry) => entry.includes(id))).toEqual([]);
  });

  it("GIVEN a crash between the steps WHEN the user retries the same delete THEN the retry finishes it", async () => {
    const { root, note } = await crashMidPurge();
    const id = note.frontmatter.id;
    const restarted = await open(root);
    await expect(restarted.purgeNote(id, note.contentHash)).resolves.toEqual({ id, title: note.frontmatter.title });
    expect(await exists(path.join(root, ".lifeos", "versions", id))).toBe(false);
    expect(await audits(restarted, "note.purged", id)).toHaveLength(1);
    expect(await restarted.recoverOperations()).toEqual([]);
  });

  it("GIVEN a crash before the file was removed and the note restored since WHEN recovery runs THEN nothing is removed", async () => {
    const context = await setup();
    const id = context.note.frontmatter.id;
    const neverRemoves = new Proxy(new MarkdownObjectStore(context.root), { get(object, property, receiver) {
      if (property === "remove") return async () => { throw new Error("simulated crash before removing the file"); };
      const value = Reflect.get(object, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    } }) as ObjectStore;
    await expect((await open(context.root, neverRemoves)).purgeNote(id, context.note.contentHash)).rejects.toThrow("simulated crash");
    // A crash leaves the journal open, but the user restores the note on the other device before the next start.
    const restarted = await open(context.root);
    await restarted.restoreNote(id, context.note.contentHash);
    await restarted.recoverOperations();
    expect(await exists(path.join(context.root, context.note.relativePath))).toBe(true);
    expect(await exists(path.join(context.root, ".lifeos", "versions", id))).toBe(true);
    expect(await audits(restarted, "note.purged", id)).toHaveLength(0);
    expect(await restarted.recoverOperations()).toEqual([]);
  });
});

describe("permanent delete over HTTP (PB-030)", () => {
  async function serve() {
    const context = await setup();
    const session = new FilesystemSessionStore(context.root, "desk-mac");
    await session.start();
    const server = Fastify();
    servers.push(server);
    registerLease(server, { session, stopping: () => false });
    registerNotePurge(server, context.application);
    server.setErrorHandler((error, _request, reply) => { const { statusCode, body } = httpError(error); reply.status(statusCode).send(body); });
    const url = `/api/v1/notes/${context.note.frontmatter.id}`;
    return { ...context, server, url };
  }

  it("GIVEN another device holds the lease THEN the delete answers 423 and the file stays", async () => {
    const { root, server, url, note } = await serve();
    await new FilesystemSessionStore(root, "laptop").takeOver();
    const response = await server.inject({ method: "DELETE", url: `${url}/permanent`, payload: { expectedHash: note.contentHash } });
    expect(response.statusCode).toBe(423);
    expect(await exists(path.join(root, note.relativePath))).toBe(true);
  });

  it("requires expectedHash, answers 409 with the references, and deletes once they are gone", async () => {
    const { root, server, url, note, application } = await serve();
    expect((await server.inject({ method: "DELETE", url: `${url}/permanent`, payload: {} })).statusCode).toBe(400);
    const taskId = await linkFromTask(root, application, "Follow up", { source_ids: [note.frontmatter.id] });

    const check = await server.inject({ method: "GET", url: `${url}/purge-check` });
    expect(check.json()).toEqual({ blockers: [{ id: taskId, type: "task", title: "Follow up" }], bodyLinks: [] });
    const refused = await server.inject({ method: "DELETE", url: `${url}/permanent`, payload: { expectedHash: note.contentHash } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().references).toEqual([{ id: taskId, type: "task", title: "Follow up" }]);

    const task = application.object(taskId);
    await new MarkdownObjectStore(root).write({ relativePath: task.relativePath, expectedHash: task.contentHash, frontmatter: { ...task.frontmatter, source_ids: [], revision: task.frontmatter.revision + 1 }, body: task.body });
    await application.rebuildIndex();
    const done = await server.inject({ method: "DELETE", url: `${url}/permanent`, payload: { expectedHash: note.contentHash } });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ id: note.frontmatter.id, title: note.frontmatter.title });
    expect(await exists(path.join(root, note.relativePath))).toBe(false);
  });
});

/** A task saved with extra front matter (or a body), as an Agent patch or Obsidian edit could leave it. Returns its id. */
async function linkFromTask(root: string, application: LifeOSApplication, title: string, extra: Record<string, unknown>, body?: string) {
  const store = new MarkdownObjectStore(root);
  const task = await application.quickCapture(title);
  await store.write({ relativePath: task.relativePath, expectedHash: task.contentHash, frontmatter: { ...task.frontmatter, ...extra, revision: task.frontmatter.revision + 1 }, body: body ?? task.body });
  await application.rebuildIndex();
  return task.frontmatter.id;
}
