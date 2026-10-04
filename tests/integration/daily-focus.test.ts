import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #46 (ADR 0011, PRD "Daily Focus and Today"): the morning routine's `daily-focus` draft becomes the
// date's brief; Today shows it with live status, and Refresh writes a `replan` Work Order.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const now = new Date("2026-10-05T12:00:00.000Z");
const date = "2026-10-05";

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-focus-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>, body = "Morning. Two things matter today: the sizing deck and the Carrefour prep.\n") {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify(fields)}---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const task = (application: LifeOSApplication, title: string, fields: Record<string, unknown> = {}) => application.createEntity("task", { title, ...fields }).then((object) => object.frontmatter.id);
async function meeting(store: MarkdownObjectStore, title: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) {
  const id = uuidV7();
  await store.write({ relativePath: `meetings/${id}.md`, frontmatter: { id, type: "meeting", schema_version: 1, revision: 1, title, created_at: startsAt, updated_at: startsAt, updated_by_device: "test", status: "confirmed", starts_at: startsAt, ends_at: endsAt, timezone: "Europe/Paris", attendee_ids: [], ...extra }, body: `# ${title}\n` });
  return id;
}
const brief = (overrides: Record<string, unknown> = {}) => ({
  lifeos_draft: 1, kind: "daily-focus", draft_key: "focus-2026-10-05-0600", origin: "agent-extracted", title: "Daily Focus 2026-10-05",
  captured_at: "2026-10-05T06:00:00+02:00", focus_on: date, generated_at: "2026-10-05T06:00:00+02:00", ...overrides
});
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const briefs = (application: LifeOSApplication) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === "daily-focus"));
const requestFiles = async (root: string) => (await readdir(path.join(root, "_inbox", "requests")).catch(() => [] as string[])).filter((name) => name.endsWith(".md"));

describe("adopting a daily-focus draft", () => {
  it("creates the daily-focus object with every section and files the draft", async () => {
    const { root, store, application } = await vault();
    const deck = await task(application, "Send the sizing deck", { priority: "High", due_on: "2026-10-04" });
    const budget = await task(application, "Approve Q4 budget");
    const chase = await task(application, "Chase legal on the DPA");
    const prep = await meeting(store, "Carrefour QBR", "2026-10-05T14:00:00.000Z", "2026-10-05T15:00:00.000Z");
    await application.rebuildIndex();
    await dropDraft(root, "focus.md", brief({
      i_owe: [{ task_id: deck, overdue: true }],
      top3: [{ task_id: deck, why_today: "Joel needs it before his board call", if_then: "If it is 9:00, then I open the deck at my desk for 45 min" }, { task_id: budget, why_today: "Finance closes Friday" }],
      waiting_and_decisions: [{ object_id: chase, age_days: 6 }],
      meeting_prep: [{ meeting_id: prep, context: "Renewal at risk", ask: "Agree the pilot scope" }],
      day_shape: { meeting_hours: 4.5, free_hours: 3 },
      defer_candidates: [{ task_id: budget, reason: "Finance can wait until Thursday" }]
    }));

    const batch = await application.adoptDrafts({ now });
    expect(batch.drafts[0]).toMatchObject({ outcome: "adopted", filedAs: "_inbox/processed/focus.md" });
    const [object] = await briefs(application);
    expect(batch.drafts[0]!.objectIds).toEqual([object!.frontmatter.id]);
    expect(object!.relativePath).toMatch(/^daily-focus\//);
    expect(object!.frontmatter).toMatchObject({
      type: "daily-focus", origin: "agent-extracted", title: "Daily Focus 2026-10-05", focus_on: date, generated_at: "2026-10-05T04:00:00.000Z",
      i_owe: [{ task_id: deck, overdue: true }],
      top3: [{ task_id: deck, why_today: "Joel needs it before his board call", if_then: "If it is 9:00, then I open the deck at my desk for 45 min" }, { task_id: budget, why_today: "Finance closes Friday" }],
      waiting_and_decisions: [{ object_id: chase, age_days: 6 }],
      meeting_prep: [{ meeting_id: prep, context: "Renewal at risk", ask: "Agree the pilot scope" }],
      day_shape: { meeting_hours: 4.5, free_hours: 3 },
      defer_candidates: [{ task_id: budget, reason: "Finance can wait until Thursday" }]
    });
    expect(application.object(object!.frontmatter.id).body).toContain("Two things matter today");
    expect(object!.frontmatter.archived_at).toBeUndefined();
  });

  it("fails a draft with every problem listed, path-aware, and writes nothing", async () => {
    const { root, store, application } = await vault();
    const meetingId = await meeting(store, "Standup", "2026-10-05T07:00:00.000Z", "2026-10-05T07:15:00.000Z");
    await application.rebuildIndex();
    const ids = [uuidV7(), uuidV7(), uuidV7(), uuidV7()];
    await dropDraft(root, "bad.md", brief({
      focus_on: "5 October", generated_at: "this morning",
      top3: ids.map((id) => ({ task_id: id, why_today: "because" })).concat([{ task_id: "not-an-id", why_today: "" }]),
      meeting_prep: ids.map(() => ({ meeting_id: meetingId })),
      defer_candidates: [{ task_id: meetingId, reason: "busy" }],
      day_shape: { meeting_hours: "lots" }
    }), `${"word ".repeat(400)}\n`);

    const [result] = (await application.adoptDrafts({ now })).drafts;
    expect(result).toMatchObject({ outcome: "failed", filedAs: "_inbox/failed/bad.md" });
    const reason = result!.reason!;
    expect(reason).toContain("_inbox/drafts/bad.md (draft_key focus-2026-10-05-0600)");
    for (const expected of ["focus_on: not a calendar date", "generated_at: not an ISO 8601", "top3: has 5 entries; at most 3", "top3.4.task_id: not an object ID", "top3.4.why_today: missing",
      "meeting_prep: has 4 entries; at most 3", `defer_candidates.0.task_id: ${meetingId} is a meeting, expected task`, "day_shape.meeting_hours: must be a number", "day_shape.free_hours: missing", "body: the brief is 400 words"]) expect(reason).toContain(expected);
    expect(await briefs(application)).toEqual([]);
    expect((await frontmatterOf(path.join(root, "_inbox", "failed", "bad.result.md"))).outcome).toBe("failed");
  });

  it("archives the older brief for the same date in place when a newer one arrives", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "first.md", brief());
    await dropDraft(root, "other-day.md", brief({ draft_key: "focus-2026-10-06", focus_on: "2026-10-06", title: "Daily Focus 2026-10-06" }));
    await application.adoptDrafts({ now });
    const first = (await briefs(application)).find((object) => object.frontmatter.focus_on === date)!;

    await dropDraft(root, "second.md", brief({ draft_key: "focus-2026-10-05-1100", generated_at: "2026-10-05T11:00:00+02:00" }), "Re-planned after the 10:00 call.\n");
    const [result] = (await application.adoptDrafts({ now })).drafts;
    const all = await briefs(application);
    const older = all.find((object) => object.frontmatter.id === first.frontmatter.id)!;
    expect(older.relativePath).toBe(first.relativePath);
    expect(older.frontmatter).toMatchObject({ archived_at: now.toISOString(), superseded_by_id: result!.objectIds[0], revision: 2 });
    expect(all.find((object) => object.frontmatter.focus_on === "2026-10-06")!.frontmatter.archived_at).toBeUndefined();
    expect(application.today({ date, now }).focus.brief).toMatchObject({ id: result!.objectIds[0], generatedAt: "2026-10-05T09:00:00.000Z" });
    expect(application.today({ date, now }).focus.brief!.body).toContain("Re-planned");
  });

  it("files a late-arriving older brief already archived, so the newest generated_at wins", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "newer.md", brief({ draft_key: "late-newer", generated_at: "2026-10-05T11:00:00Z" }));
    await application.adoptDrafts({ now });
    await dropDraft(root, "older.md", brief({ draft_key: "late-older", generated_at: "2026-10-05T05:00:00Z" }));
    const [result] = (await application.adoptDrafts({ now })).drafts;
    expect(result!.outcome).toBe("adopted");
    const older = application.object(result!.objectIds[0]!);
    expect(older.frontmatter.archived_at).toBe(now.toISOString());
    expect(application.today({ date, now }).focus.brief!.generatedAt).toBe("2026-10-05T11:00:00.000Z");
  });

  it("supersedes correctly when two briefs for the same date arrive in one batch", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "a.md", brief({ draft_key: "a", generated_at: "2026-10-05T06:00:00Z" }));
    await dropDraft(root, "b.md", brief({ draft_key: "b", generated_at: "2026-10-05T08:00:00Z" }));
    await application.adoptDrafts({ now });
    const live = (await briefs(application)).filter((object) => !object.frontmatter.archived_at);
    expect(live).toHaveLength(1);
    expect(live[0]!.frontmatter.generated_at).toBe("2026-10-05T08:00:00.000Z");
  });

  it("treats a re-sent identical brief as a duplicate and archives nothing", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "focus.md", brief());
    const [first] = (await application.adoptDrafts({ now })).drafts;
    await dropDraft(root, "focus.md", brief());
    const [again] = (await application.adoptDrafts({ now })).drafts;
    expect(again).toMatchObject({ outcome: "duplicate", objectIds: first!.objectIds });
    expect(await briefs(application)).toHaveLength(1);
    expect(application.object(first!.objectIds[0]!).frontmatter.archived_at).toBeUndefined();
  });
});

describe("Today with the Daily Focus brief", () => {
  it("overlays live status: finished tasks struck and sunk, past meetings marked, restricted hidden, deleted shown as missing", async () => {
    const { root, store, application } = await vault();
    const done = await task(application, "Already sent");
    const cancelled = await task(application, "No longer needed");
    const open = await task(application, "Still to do");
    const secret = await task(application, "Private matter");
    const deleted = await task(application, "Removed later");
    const past = await meeting(store, "Morning sync", "2026-10-05T07:00:00.000Z", "2026-10-05T08:00:00.000Z");
    const later = await meeting(store, "Carrefour QBR", "2026-10-05T14:00:00.000Z", "2026-10-05T15:00:00.000Z");
    await application.rebuildIndex();
    const unknown = uuidV7();
    await dropDraft(root, "focus.md", brief({
      i_owe: [{ task_id: done, overdue: false }, { task_id: open, overdue: false }],
      top3: [{ task_id: done, why_today: "a" }, { task_id: deleted, why_today: "b" }, { task_id: open, why_today: "c", if_then: "If 10:00 then desk" }],
      waiting_and_decisions: [{ object_id: cancelled, age_days: 3 }, { object_id: secret, age_days: 9 }, { object_id: unknown, age_days: 1 }],
      meeting_prep: [{ meeting_id: past, context: "x", ask: "y" }, { meeting_id: later, context: "Renewal", ask: "Pilot scope" }],
      day_shape: { meeting_hours: 2, free_hours: 5.5 },
      defer_candidates: [{ task_id: open, reason: "Too much today" }]
    }));
    await application.adoptDrafts({ now });

    const hash = (id: string) => application.object(id).contentHash;
    await application.updateTask(done, { status: "Done" }, hash(done));
    await application.updateTask(cancelled, { status: "Cancelled" }, hash(cancelled));
    await application.setSensitivity(secret, "restricted", hash(secret));
    await application.deleteEntity(deleted, hash(deleted));

    const { focus } = application.today({ date, now });
    expect(focus.top3Source).toBe("brief");
    expect(focus.brief!.generatedAt).toBe("2026-10-05T04:00:00.000Z");
    expect(focus.iOwe.map((item) => [item.id, item.state])).toEqual([[open, "open"], [done, "done"]]);
    expect(focus.top3.map((item) => [item.id, item.state, item.whyToday])).toEqual([[open, "open", "c"], [done, "done", "a"], [deleted, "missing", "b"]]);
    expect(focus.top3[0]).toMatchObject({ ifThen: "If 10:00 then desk", object: { frontmatter: { title: "Still to do" } } });
    expect(focus.top3[2]!.object).toBeUndefined();
    expect(focus.waitingAndDecisions.map((item) => [item.id, item.state, item.ageDays])).toEqual([[cancelled, "cancelled", 3], [unknown, "missing", 1]]);
    expect(focus.meetingPrep.map((item) => [item.id, item.state])).toEqual([[past, "past"], [later, "open"]]);
    expect(focus.meetingPrep[1]).toMatchObject({ context: "Renewal", ask: "Pilot scope" });
    expect(focus.dayShape).toEqual({ meetingHours: 2, freeHours: 5.5 });
    expect(focus.deferCandidates).toMatchObject([{ id: open, reason: "Too much today" }]);
    expect(focus.restrictedHidden).toBe(1);
    expect(JSON.stringify(focus)).not.toContain("Private matter");
  });

  it("keeps the deterministic Top 3 (priority, then due date) when no brief exists for the date", async () => {
    const { root, application } = await vault();
    const low = await task(application, "Low one", { priority: "Low" });
    const highLater = await task(application, "High later", { priority: "High", due_on: "2026-10-20" });
    const highSoon = await task(application, "High soon", { priority: "High", due_on: "2026-10-05" });
    const secret = await task(application, "High secret", { priority: "High", due_on: "2026-10-01" });
    await application.setSensitivity(secret, "restricted", application.object(secret).contentHash);
    await dropDraft(root, "tomorrow.md", brief({ focus_on: "2026-10-06", draft_key: "tomorrow" }));
    await application.adoptDrafts({ now });

    const { focus } = application.today({ date, now });
    expect(focus.brief).toBeUndefined();
    expect(focus.top3Source).toBe("rule");
    expect(focus.top3.map((item) => item.id)).toEqual([highSoon, highLater, low]);
    expect(focus.top3[0]!.whyToday).toBe("Due or overdue");
    expect(focus.iOwe).toEqual([]);
  });

  it("Refresh writes one replan Work Order to _inbox/requests/ and does not touch the brief", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "focus.md", brief());
    await application.adoptDrafts({ now });
    const current = application.today({ date, now }).focus.brief!;

    const request = await application.requestReplan(date, { now });
    expect(request).toMatchObject({ alreadyRequested: false });
    const [file] = await requestFiles(root);
    expect(request.workOrder).toBe(`_inbox/requests/${file}`);
    const raw = await readFile(path.join(root, "_inbox", "requests", file!), "utf8");
    expect(await frontmatterOf(path.join(root, "_inbox", "requests", file!))).toMatchObject({ lifeos_work_order: 1, kind: "replan", requested_at: now.toISOString(), focus_on: date, current_brief_id: current.id, current_brief_path: current.path });
    expect(raw).toContain("restricted");

    const again = await application.requestReplan(date, { now });
    expect(again).toMatchObject({ alreadyRequested: true, workOrder: request.workOrder });
    expect(await requestFiles(root)).toHaveLength(1);
    expect(application.object(current.id).frontmatter.revision).toBe(1);

    await application.requestReplan("2026-10-06", { now });
    expect(await requestFiles(root)).toHaveLength(2);
    await expect(application.requestReplan("tomorrow", { now })).rejects.toThrow(/calendar date/);
  });

  it("Refresh with no brief yet still asks Claude to plan the date", async () => {
    const { root, application } = await vault();
    await application.requestReplan(date, { now });
    const [file] = await requestFiles(root);
    const fields = await frontmatterOf(path.join(root, "_inbox", "requests", file!));
    expect(fields).toMatchObject({ kind: "replan", focus_on: date });
    expect(fields.current_brief_id).toBeUndefined();
  });
});
