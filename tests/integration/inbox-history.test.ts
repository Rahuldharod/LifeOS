import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockAiProvider } from "@lifeos/ai";
import { inboxHistoryLimit, LifeOSApplication } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemAgentIndexWriter, FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { testApi } from "./test-api.js";

// #243: the Inbox History, read from the audit ledger (ADR 0025): last 100 Review actions, who, undo state, applied Patch Drafts.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function open() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-inbox-history-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), new MockAiProvider(), "test", new FilesystemInboxStore(root), new FilesystemAgentIndexWriter(root), { agentIndexDebounceMs: 60_000, timeZone: "Europe/Paris" });
  await application.rebuildIndex();
  return { root, application };
}

/** A meeting whose notes yield create proposals. */
async function proposals() {
  const context = await open();
  const { application } = context;
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const reviews = await application.processMeeting(workspace.meeting.frontmatter.id);
  return { ...context, meeting: workspace.meeting, reviews, ids: reviews.map((review) => review.frontmatter.id) };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
const history = async (application: LifeOSApplication) => (await application.rebuildIndex(), application.inboxHistory());

describe("Inbox History", () => {
  it("lists accepts and rejects newest first, by you, with the Review kind, the item and its Source meeting", async () => {
    const { application, meeting, ids } = await proposals();
    expect(ids.length).toBeGreaterThan(1);
    const created = await application.acceptReviewItem(ids[0]!);
    await pause();
    await application.rejectReviewItem(ids[1]!);

    const entries = await history(application);
    expect(entries.map((entry) => entry.action)).toEqual(["rejected", "accepted"]);
    expect(entries[0]).toMatchObject({ actor: "you", source: "review", reviewId: ids[1], title: application.object(ids[1]!).frontmatter.title, sourceMeetingId: meeting.frontmatter.id, sourceMeetingTitle: meeting.frontmatter.title, restricted: false, undone: false, undoable: true });
    expect(entries[0]!.objectId).toBeUndefined();
    expect(entries[1]).toMatchObject({ actor: "you", action: "accepted", reviewId: ids[0], reviewType: "create", objectId: created.frontmatter.id, undone: false, undoable: true });
    expect(entries[1]!.at <= entries[0]!.at).toBe(true);
  });

  it("keeps the last 100, newest first", async () => {
    const { application, ids } = await proposals();
    expect(inboxHistoryLimit).toBe(100);
    for (let round = 0; round < 105; round += 1) {
      await application.rejectReviewItem(ids[0]!);
      await application.undoReviewAction(ids[0]!);
    }
    await application.rejectReviewItem(ids[0]!);
    const entries = await history(application);
    expect(entries).toHaveLength(100);
    expect([...entries].sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id)).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(entries[0]).toMatchObject({ undone: false, undoable: true });
    expect(entries.slice(1).every((entry) => entry.undone)).toBe(true);
    expect(application.inboxHistory(3)).toHaveLength(3);
  }, 120_000);

  it("marks a decision Undone after review.undone, takes the object link away, and lists a later decision as the live one", async () => {
    const { application, ids } = await proposals();
    await application.rejectReviewItem(ids[0]!);
    expect((await history(application))[0]).toMatchObject({ action: "rejected", undone: false, undoable: true });
    await application.undoReviewAction(ids[0]!);
    await pause();
    const accepted = await application.acceptReviewItem(ids[0]!);
    const [latest, earlier] = await history(application);
    expect(earlier).toMatchObject({ action: "rejected", undone: true, undoable: false });
    expect(latest).toMatchObject({ action: "accepted", undone: false, undoable: true, objectId: accepted.frontmatter.id });

    await application.undoReviewAction(ids[0]!);
    const [after] = await history(application);
    expect(after).toMatchObject({ action: "accepted", undone: true, undoable: false });
    expect(after!.objectId).toBeUndefined();
  });

  it("classes an action as the System when its audit was not written as a person, and a person as You", async () => {
    const { root, application, ids } = await proposals();
    await application.rejectReviewItem(ids[0]!);
    await pause();
    // Another actor's audit, as a future auto-accept would write it (the same shape the app writes, actor_type: system).
    const id = uuidV7(); const at = new Date().toISOString();
    await mkdir(path.join(root, "audit"), { recursive: true });
    await writeFile(path.join(root, "audit", `${at.slice(0, 10)}-review-rejected--${id}.md`), `---\n${stringify({ id, type: "audit-event", schema_version: 1, revision: 1, title: "review.rejected", created_at: at, updated_at: at, updated_by_device: "test", occurred_at: at, actor_type: "system", action: "review.rejected", object_id: ids[1], metadata: {} }).trimEnd()}\n---\n# review.rejected\n`);

    const entries = await history(application);
    expect(entries.map((entry) => [entry.reviewId, entry.actor])).toEqual([[ids[1], "system"], [ids[0], "you"]]);
  });

  it("shows an applied Patch Draft as a System row with its own Undo state, and Undone once undone", async () => {
    const { root, application } = await open();
    const task = await application.quickCapture("Send Joel the sizing deck");
    const drop = path.join(root, "_inbox", "patches", "done.md");
    await mkdir(path.dirname(drop), { recursive: true });
    await writeFile(drop, `---\n${stringify({ lifeos_patch: 1, draft_key: "phone-1", origin: "user-dictated", captured_at: "2026-10-04T10:00:00+02:00", id: task.frontmatter.id, set: { priority: "High" } }).trimEnd()}\n---\n`);
    const past = new Date(Date.now() - 60_000); await utimes(drop, past, past);
    await application.adoptDrafts();

    const [entry] = await history(application);
    expect(entry).toMatchObject({ source: "patch", actor: "system", action: "applied", reviewType: "update", title: "Send Joel the sizing deck", objectId: task.frontmatter.id, summary: "priority none → High", undone: false, undoable: true, restricted: false });
    const audit = application.object(entry!.id);
    expect(audit.frontmatter).toMatchObject({ action: "patch.applied", actor_type: "agent" });

    await application.undoPatch(entry!.id);
    expect((await history(application))[0]).toMatchObject({ source: "patch", undone: true, undoable: false });
  });

  it("flags a restricted item, and writes nothing about it into the Agent Index", async () => {
    const { root, application, ids } = await proposals();
    const title = application.object(ids[0]!).frontmatter.title;
    await application.setSensitivity(ids[0]!, "restricted", application.object(ids[0]!).contentHash);
    await application.rejectReviewItem(ids[0]!);
    expect((await history(application))[0]).toMatchObject({ reviewId: ids[0], restricted: true });

    await application.writeAgentIndex({ now: new Date() });
    for (const file of await readdir(path.join(root, "_agent"))) expect(await readFile(path.join(root, "_agent", file), "utf8")).not.toContain(title);
  });

  it("lists a second accept of the same link or change after an undo (the audit is per round)", async () => {
    const { application, ids } = await proposals();
    // A create item: each accept makes a new object, so each audits. The rule for a link/update (same target) is the operation_id.
    await application.acceptReviewItem(ids[0]!);
    await application.undoReviewAction(ids[0]!);
    await pause();
    await application.acceptReviewItem(ids[0]!);
    expect((await history(application)).filter((entry) => entry.action === "accepted")).toHaveLength(2);
  });
});

function person(title: string, email: string) {
  const id = uuidV7();
  const now = "2026-09-01T08:00:00.000Z";
  return { id, file: { [`people/${id}.md`]: `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: ${now}\nupdated_at: ${now}\nupdated_by_device: test\ngiven_name: ${title.split(" ")[0]}\nidentifiers:\n  - kind: email\n    value: ${email}\n---\n# ${title}\n` } };
}

describe("GET /api/v1/inbox/history", () => {
  it("lists a link as linked with the task, marks it Undone after an undo, and lists the second accept as its own row", async () => {
    const martin = person("Joel Martin", "joel.martin@example.com");
    const durand = person("Joël Durand", "joel@example.org");
    const { root, call, start } = await testApi({ files: { ...martin.file, ...durand.file }, timing: { adoptionDebounceMs: 3_600_000, adoptionSweepMs: 3_600_000 } });
    await start();
    expect(await call("GET /api/v1/inbox/history")).toEqual([]);
    await call("PUT /api/v1/settings/internal-domains", { body: { domains: ["example.com"] } });
    const target = path.join(root, "_inbox", "drafts", "link.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\nlifeos_draft: 1\nkind: task\ndraft_key: link.md\norigin: user-dictated\ntitle: Send the sizing deck\ncaptured_at: "2026-10-04T09:15:00+02:00"\nstatus: Waiting\nwaiting_for: Joel\n---\n`);
    const past = new Date(Date.now() - 60_000); await utimes(target, past, past);
    await call("POST /api/v1/inbox/adopt");
    const reviewId = (await call("GET /api/v1/review-items")).find((item) => item.frontmatter.review_type === "link-resolution")!.frontmatter.id;

    await call("POST /api/v1/review-items/:id/accept", { params: { id: reviewId }, body: { linkTo: durand.id } });
    const taskId = (await call("GET /api/v1/objects")).find((object) => object.frontmatter.type === "task")!.frontmatter.id;
    const [linked] = await call("GET /api/v1/inbox/history");
    expect(linked).toMatchObject({ action: "linked", actor: "you", reviewType: "link-resolution", reviewId, objectId: taskId, undone: false, undoable: true });

    await call("POST /api/v1/review-items/:id/undo", { params: { id: reviewId } });
    expect(await call("GET /api/v1/inbox/history")).toEqual([expect.objectContaining({ id: linked!.id, undone: true, undoable: false })]);
    await new Promise((resolve) => setTimeout(resolve, 3));
    await call("POST /api/v1/review-items/:id/accept", { params: { id: reviewId }, body: { linkTo: martin.id } });
    const rows = await call("GET /api/v1/inbox/history");
    expect(rows.map((row) => [row.action, row.undone])).toEqual([["linked", false], ["linked", true]]);
  });
});
