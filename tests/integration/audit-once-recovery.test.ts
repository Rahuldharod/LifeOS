import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import type { ObjectEnvelope } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #78: every journalled step writes its audit exactly once, even when the process dies after the audit and
// before its operation is closed, and replays (startup recovery, or the user retrying) run it again.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type WriteInput = { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string };

/** A store whose process "dies" at a chosen point: closing an operation of one kind, after preparing one, or on a write. */
class CrashingStore extends MarkdownObjectStore {
  crashOnClose?: string;
  crashAfterPrepare?: string;
  crashOnWrite?: (input: WriteInput) => boolean;
  override async completeOperation(operationId: string) {
    if (this.crashOnClose && (await this.incompleteOperations()).find((operation) => operation.id === operationId)?.kind === this.crashOnClose) {
      this.crashOnClose = undefined;
      throw new Error("power cut");
    }
    return super.completeOperation(operationId);
  }
  override async prepareOperation(kind: string, payload: Record<string, unknown>, operationId: string) {
    const prepared = await super.prepareOperation(kind, payload, operationId);
    if (this.crashAfterPrepare === kind) { this.crashAfterPrepare = undefined; throw new Error("power cut"); }
    return prepared;
  }
  override async write(input: WriteInput) {
    if (this.crashOnWrite?.(input)) { this.crashOnWrite = undefined; throw new Error("power cut"); }
    return super.write(input);
  }
}

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

/** Opens the vault at `root` (a fresh process on restart: new store, index and caches). */
async function open(root?: string, calendar: CalendarConnector = new MockCalendarConnector()) {
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-audit-once-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new CrashingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, new MockAiProvider(), "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

/** Startup after a crash: rebuild, recover, rebuild (as apps/server does). */
async function restart(root: string, calendar?: CalendarConnector) {
  const context = await open(root, calendar);
  await context.application.recoverOperations();
  await context.application.rebuildIndex();
  return context;
}

/** The audit events with `action` on disk (the index is rebuilt first: a crashed step may not have rebuilt it). */
const audits = async (application: LifeOSApplication, action: string) => (await application.rebuildIndex(), await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action);

async function editOnDisk(root: string, relativePath: string, changes: Record<string, unknown>) {
  const file = path.join(root, relativePath);
  const [, yaml, body] = (await readFile(file, "utf8")).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
  await writeFile(file, `---\n${stringify({ ...parse(yaml!), ...changes }).trimEnd()}\n---\n${body}`);
}

async function dropPatch(root: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox/patches/patch.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_patch: 1, draft_key: "patch-1", origin: "user-dictated", captured_at: "2026-01-01T09:00:00Z", ...fields }).trimEnd()}\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

/** A meeting with extracted create proposals (accept-review operations). */
async function proposals() {
  const context = await open();
  const { application } = context;
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const reviews = await application.processMeeting(workspace.meeting.frontmatter.id);
  return { ...context, reviewId: reviews[0]!.frontmatter.id };
}

/** A person-merge Review Item between a person and a calendar-created duplicate. */
async function mergeScenario() {
  const calendar = new FakeCalendar();
  const context = await open(undefined, calendar);
  const { application } = context;
  const keep = await application.createEntity("person", { title: "Marie Curie" });
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  calendar.events = [{ externalId: "e1", title: "Pilot", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: ["Marie Curie"], attendeeDetails: [{ displayName: "Marie Curie" }, { email: "marie.curie@example.com", displayName: "Marie Curie" }] }];
  await application.createMeetingFromEvent("e1");
  const dup = (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.origin === "calendar")!;
  const task = await application.createEntity("task", { title: "Send Marie the deck", owner_person_id: dup.frontmatter.id });
  const [reviewId] = await application.suggestPersonMerges();
  return { ...context, calendar, keepId: keep.frontmatter.id, dupId: dup.frontmatter.id, taskId: task.frontmatter.id, reviewId: reviewId! };
}

describe("a crash between a journalled step's audit and closing its operation writes the audit once (#78)", () => {
  it("supersede-decision: finished by recovery, one decision.superseded", async () => {
    const { root, store, application } = await open();
    const old = await application.createDecision({ title: "Budget is 10k" });
    store.crashOnClose = "supersede-decision";
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Budget is 12k" }, old.contentHash)).rejects.toThrow(/power cut/);
    expect(await audits(application, "decision.superseded")).toHaveLength(1);

    const restarted = await restart(root);
    expect(await audits(restarted.application, "decision.superseded")).toHaveLength(1);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("supersede-decision abandoned: one decision.supersede-abandoned", async () => {
    const { root, store, application } = await open();
    const old = await application.createDecision({ title: "Budget is 10k" });
    store.crashAfterPrepare = "supersede-decision";
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Budget is 12k" }, old.contentHash)).rejects.toThrow(/power cut/);
    await editOnDisk(root, old.relativePath, { rationale: "Edited after the crash" });

    const crashed = await open(root);
    crashed.store.crashOnClose = "supersede-decision";
    await crashed.application.recoverOperations();
    expect(await audits(crashed.application, "decision.supersede-abandoned")).toHaveLength(1);
    expect(await crashed.store.incompleteOperations()).toHaveLength(1);

    const restarted = await restart(root);
    expect(await audits(restarted.application, "decision.supersede-abandoned")).toHaveLength(1);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("resolve-open-point: finished by recovery, one open-point.resolved", async () => {
    const { root, store, application } = await open();
    const point = await application.createOpenPoint({ title: "Which vendor?" });
    store.crashOnClose = "resolve-open-point";
    await expect(application.resolveOpenPointWithDecision(point.frontmatter.id, { title: "Vendor A" }, point.contentHash)).rejects.toThrow(/power cut/);

    const restarted = await restart(root);
    expect(await audits(restarted.application, "open-point.resolved")).toHaveLength(1);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("create-meeting: finished by recovery, one meeting.created", async () => {
    const { root, store, application } = await open();
    const [event] = await application.listCalendarEvents();
    store.crashOnClose = "create-meeting";
    await expect(application.createMeetingFromEvent(event!.externalId)).rejects.toThrow(/power cut/);

    const restarted = await restart(root);
    expect(await audits(restarted.application, "meeting.created")).toHaveLength(1);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("accept-review: finished by recovery, one review.accepted", async () => {
    const { root, store, application, reviewId } = await proposals();
    store.crashOnClose = "accept-review";
    await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);

    const restarted = await restart(root);
    expect((await audits(restarted.application, "review.accepted")).filter((audit) => (audit.frontmatter.metadata as Record<string, unknown>).review_id === reviewId)).toHaveLength(1);
    expect(restarted.application.object(reviewId).frontmatter.status).toBe("accepted");
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("accept-review rolled back on reject: retrying the reject writes one review.accept-rolled-back", async () => {
    const { root, store, application, reviewId } = await proposals();
    store.crashOnWrite = (input) => input.frontmatter.type === "review-item" && input.frontmatter.status === "accepted";
    await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);
    store.crashOnClose = "accept-review";
    await expect(application.rejectReviewItem(reviewId)).rejects.toThrow(/power cut/);

    const retried = await open(root);
    expect((await retried.application.rejectReviewItem(reviewId)).frontmatter.status).toBe("rejected");
    expect(await audits(retried.application, "review.accept-rolled-back")).toHaveLength(1);
    expect(await retried.store.incompleteOperations()).toEqual([]);
  });

  it("merge-person: finished by recovery, one person.merged", async () => {
    const { root, store, application, calendar, reviewId } = await mergeScenario();
    store.crashOnClose = "merge-person";
    await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);

    const restarted = await restart(root, calendar);
    expect(await audits(restarted.application, "person.merged")).toHaveLength(1);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("merge-person rolled back on reject: retrying the reject writes one person.merge-rolled-back", async () => {
    const { root, store, application, calendar, reviewId } = await mergeScenario();
    store.crashOnWrite = (input) => !!input.frontmatter.merged_into_person_id;
    await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);
    store.crashOnClose = "merge-person";
    await expect(application.rejectReviewItem(reviewId)).rejects.toThrow(/power cut/);

    const retried = await open(root, calendar);
    expect((await retried.application.rejectReviewItem(reviewId)).frontmatter.status).toBe("rejected");
    expect(await audits(retried.application, "person.merge-rolled-back")).toHaveLength(1);
    expect(await retried.store.incompleteOperations()).toEqual([]);
  });

  it("merge-person rolled back because a file changed: one person.merge-rolled-back", async () => {
    const { root, store, application, calendar, reviewId, taskId } = await mergeScenario();
    // The user re-assigns the task (a file the merge touches) before the merge is retried.
    const other = await application.createEntity("person", { title: "Pierre Curie" });
    const keepId = other.frontmatter.id;
    store.crashOnWrite = (input) => !!input.frontmatter.merged_into_person_id;
    await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);
    await editOnDisk(root, application.object(taskId).relativePath, { owner_person_id: keepId });

    const crashed = await open(root, calendar);
    crashed.store.crashOnClose = "merge-person";
    await expect(crashed.application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);

    const restarted = await restart(root, calendar);
    expect(await audits(restarted.application, "person.merge-rolled-back")).toHaveLength(1);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("apply-patch: finished by recovery, one patch.applied", async () => {
    const { root, store, application } = await open();
    const task = await application.createEntity("task", { title: "Ship the pilot" });
    await dropPatch(root, { id: task.frontmatter.id, set: { priority: "High" } });
    store.crashOnClose = "apply-patch";
    await application.adoptDrafts().catch(() => undefined);

    const restarted = await restart(root);
    await restarted.application.adoptDrafts();
    expect(await audits(restarted.application, "patch.applied")).toHaveLength(1);
    expect(restarted.application.object(task.frontmatter.id).frontmatter.priority).toBe("High");
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });
});

// #78: a supersede abandoned during recovery leaves nothing open, so later starts stay quiet.
describe("a supersede from an update Review Item abandoned during recovery (#78)", () => {
  it("closes every operation, keeps the item pending with a visible conflict, and adds no System Health line on later starts", async () => {
    const { root, store, application } = await open();
    const old = await application.createDecision({ title: "Use Postgres" });
    await application.createDecision({ title: "Use DuckDB" });
    const target = path.join(root, "_inbox/patches/supersede.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\n${stringify({ lifeos_patch: 1, draft_key: "supersede", origin: "user-dictated", captured_at: "2026-01-01T09:00:00Z", id: old.frontmatter.id, set: { superseded_by: "use duckdb" } }).trimEnd()}\n---\n`);
    const past = new Date(Date.now() - 60_000);
    await utimes(target, past, past);
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
    const reviewId = application.reviews().find((item) => item.frontmatter.review_type === "update")!.frontmatter.id;
    store.crashAfterPrepare = "supersede-decision";
    await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);
    await editOnDisk(root, old.relativePath, { rationale: "Edited in Obsidian after the crash" });

    for (let start = 0; start < 3; start++) {
      const restarted = await restart(root);
      expect(await restarted.store.incompleteOperations()).toEqual([]);
      expect((await restarted.application.health()).diagnostics.filter((line) => line.startsWith("Recovery of"))).toEqual([]);
      expect(await audits(restarted.application, "decision.supersede-abandoned")).toHaveLength(1);
      expect(restarted.application.object(reviewId).frontmatter.status).toBe("pending");
    }
    const last = await open(root);
    await expect(last.application.acceptReviewItem(reviewId)).rejects.toMatchObject({ name: "ObjectConflictError", message: expect.stringMatching(/changed since this review item was raised/) });
    expect(await last.store.incompleteOperations()).toEqual([]);
  });
});
