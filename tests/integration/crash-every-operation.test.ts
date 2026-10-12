import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication, operationKinds, type CalendarConnector, type CalendarEvent, type OperationKind } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { CrashingStore } from "./crash-store.js";

// #160: every journalled operation kind (ADR 0013) is crashed after each change it makes, then the app restarts
// (rebuild, startup recovery, rebuild) and, where the scenario says so, the user tries again. Whatever the crash point,
// the vault ends like a run without a crash: the same objects, every audit once, and no operation left open.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

/** Opens the vault at `root` as a fresh process: new store, index and caches. */
async function open(root: string, calendar: CalendarConnector) {
  const store = new CrashingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, new MockAiProvider(), "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { store, application };
}

async function dropInbox(root: string, folder: "drafts" | "patches", name: string, fields: Record<string, unknown>, body = "") {
  const target = path.join(root, "_inbox", folder, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ captured_at: "2026-10-04T09:15:00+02:00", origin: "user-dictated", ...fields }).trimEnd()}\n---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

interface Scenario {
  /** Builds the vault the operation starts from, in its own process; returns what `act` and `retry` need. */
  setup: (root: string, application: LifeOSApplication, calendar: CalendarConnector) => Promise<Record<string, string>>;
  calendar?: () => CalendarConnector;
  /** The user action that journals the operation. */
  act: (application: LifeOSApplication, state: Record<string, string>) => Promise<unknown>;
  /** After the restart: what the user does next if the action did not finish (e.g. adoption runs again). */
  retry?: (application: LifeOSApplication, state: Record<string, string>) => Promise<unknown>;
  /** Kind-specific checks on the final vault. */
  check?: (objects: LifeOSObject[], state: Record<string, string>) => void;
}

const reviewStatus = (objects: LifeOSObject[], id: string) => objects.find((object) => object.frontmatter.id === id)?.frontmatter.status;

/** A meeting whose notes yield create proposals; the first one is the Review Item to act on. */
async function meetingProposal(_root: string, application: LifeOSApplication) {
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const reviews = await application.processMeeting(workspace.meeting.frontmatter.id);
  return { reviewId: reviews[0]!.frontmatter.id };
}

/** A person-merge Review Item between a person and the duplicate a calendar meeting created. */
function mergeCalendar() {
  const calendar = new FakeCalendar();
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  calendar.events = [{ externalId: "e1", title: "Pilot", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: ["Marie Curie"], attendeeDetails: [{ displayName: "Marie Curie" }, { email: "marie.curie@example.com", displayName: "Marie Curie" }] }];
  return calendar;
}
async function mergeProposal(_root: string, application: LifeOSApplication) {
  await application.createEntity("person", { title: "Marie Curie" });
  await application.createMeetingFromEvent("e1");
  const duplicate = (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.origin === "calendar")!;
  await application.createEntity("task", { title: "Send Marie the deck", owner_person_id: duplicate.frontmatter.id });
  const [reviewId] = await application.suggestPersonMerges();
  return { reviewId: reviewId! };
}

/** Accepting or rejecting again is how the user finishes a Review Item that is still pending after the restart. */
const decideAgain = (decision: "accept" | "reject") => async (application: LifeOSApplication, { reviewId }: Record<string, string>) => {
  if (application.object(reviewId!).frontmatter.status !== "pending") return;
  await (decision === "accept" ? application.acceptReviewItem(reviewId!) : application.rejectReviewItem(reviewId!));
};

function recurrenceCalendar() {
  const calendar = new FakeCalendar();
  const event = (input: { externalId: string; seriesId: string; startsAt: string; previousSeriesId?: string }): CalendarEvent => ({
    externalId: input.externalId,
    calendarId: "work",
    title: "Weekly planning",
    startsAt: input.startsAt,
    endsAt: new Date(Date.parse(input.startsAt) + 1_800_000).toISOString(),
    timezone: "Europe/Paris",
    attendees: [],
    seriesId: input.seriesId,
    seriesUid: "provider-weekly-planning",
    previousSeriesId: input.previousSeriesId,
    originalOccurrenceStartsAt: input.startsAt
  });
  calendar.events = [
    event({ externalId: "series-before", seriesId: "series-a", startsAt: "2026-10-05T08:00:00.000Z" }),
    event({ externalId: "series-after", seriesId: "series-b", previousSeriesId: "series-a", startsAt: "2026-10-12T08:00:00.000Z" })
  ];
  return calendar;
}

async function legacyRecurringNote(root: string, application: LifeOSApplication) {
  const meetingId = uuidV7();
  const noteId = uuidV7();
  const timestamp = "2026-10-11T12:00:00.000Z";
  const startsAt = "2026-10-12T08:00:00.000Z";
  const seriesId = "synthetic:work:weekly-planning";
  await mkdir(path.join(root, "meetings"), { recursive: true });
  await writeFile(path.join(root, "meetings", `${meetingId}.md`), `---\n${stringify({ id: meetingId, type: "meeting", schema_version: 1, revision: 1, title: "Weekly planning", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", origin: "calendar", status: "scheduled", starts_at: startsAt, ends_at: "2026-10-12T08:30:00.000Z", timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: seriesId, recurrence_occurrence_id: `${seriesId}:${startsAt}`, original_occurrence_starts_at: startsAt }).trimEnd()}\n---\n# Weekly planning\n`);
  await writeFile(path.join(root, "meetings", `${noteId}-note.md`), `---\n${stringify({ id: noteId, type: "meeting-note", schema_version: 1, revision: 1, title: "Weekly planning notes", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", origin: "app", meeting_id: meetingId }).trimEnd()}\n---\nLegacy notes survive migration.\n`);
  await application.rebuildIndex();
  return { meetingId, noteId, noteHash: application.object(noteId).contentHash };
}

/**
 * One scenario per kind. Typed over every `OperationKind`, so a new kind does not compile until it has one; the test
 * below also fails at run time if the journal names a kind this table misses.
 */
const scenarios: Record<OperationKind, Scenario> = {
  [operationKinds.acceptReview]: {
    setup: meetingProposal,
    act: (application, { reviewId }) => application.acceptReviewItem(reviewId!),
    retry: decideAgain("accept"),
    check: (objects, { reviewId }) => expect(reviewStatus(objects, reviewId!)).toBe("accepted")
  },
  [operationKinds.mergePerson]: {
    calendar: mergeCalendar,
    setup: mergeProposal,
    act: (application, { reviewId }) => application.acceptReviewItem(reviewId!),
    retry: decideAgain("accept"),
    check: (objects, { reviewId }) => {
      expect(reviewStatus(objects, reviewId!)).toBe("accepted");
      expect(objects.filter((object) => object.frontmatter.type === "person" && object.frontmatter.merged_into_person_id)).toHaveLength(1);
    }
  },
  [operationKinds.rejectReview]: {
    // The user accepts, the accept fails part-way while the app keeps running, then the user rejects instead (#82).
    setup: async (root, application, calendar) => {
      const state = await meetingProposal(root, application);
      const interrupted = await open(root, calendar);
      interrupted.store.arm(2);
      await expect(interrupted.application.acceptReviewItem(state.reviewId)).rejects.toThrow(/simulated crash/);
      return state;
    },
    act: (application, { reviewId }) => application.rejectReviewItem(reviewId!),
    retry: decideAgain("reject"),
    check: (objects, { reviewId }) => expect(reviewStatus(objects, reviewId!)).toBe("rejected")
  },
  [operationKinds.createMeeting]: {
    setup: async (_root, application) => ({ externalId: (await application.listCalendarEvents())[0]!.externalId }),
    act: (application, { externalId }) => application.createMeetingFromEvent(externalId!),
    // Opening the event again is how the user (or the next calendar sync) finishes a meeting that was never journalled.
    retry: (application, { externalId }) => application.createMeetingFromEvent(externalId!)
  },
  [operationKinds.linkRecurringSeries]: {
    // #172: nothing journals this kind any more (series Notes are Legacy and never rewritten, ADR 0021), but an old journal of it
    // must still recover. The vault holds two Legacy shared Notes and a pending journal; recovery closes it and leaves both Notes as they were.
    calendar: recurrenceCalendar,
    setup: async (root, application) => {
      const timestamp = "2026-10-11T12:00:00.000Z";
      const legacy = async (n: { externalId: string; seriesId: string; startsAt: string; previousSeriesId?: string }) => {
        const meetingId = uuidV7();
        const noteId = uuidV7();
        const seriesKey = `fake:work:${n.seriesId}`;
        const stamp = { schema_version: 1, revision: 1, created_at: timestamp, updated_at: timestamp, updated_by_device: "test" };
        const meeting = { id: meetingId, type: "meeting", ...stamp, title: "Weekly planning", origin: "calendar", status: "scheduled", starts_at: n.startsAt, ends_at: n.startsAt, timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: seriesKey, recurrence_occurrence_id: `${seriesKey}:${n.startsAt}`, original_occurrence_starts_at: n.startsAt, external_refs: [{ provider: "fake", external_id: n.externalId, calendar_id: "work", series_id: n.seriesId, original_occurrence_starts_at: n.startsAt }] };
        const note = { id: noteId, type: "meeting-note", ...stamp, title: "Weekly planning notes", origin: "app", meeting_id: meetingId, meeting_ids: [meetingId], recurrence_series_id: seriesKey, recurrence_series_uid: "provider-weekly-planning", occurrence_sections: [{ occurrence_id: `${seriesKey}:${n.startsAt}`, section_id: `s-${n.seriesId}`, meeting_id: meetingId, original_starts_at: n.startsAt, starts_at: n.startsAt }], ...(n.previousSeriesId ? { previous_recurrence_series_id: `fake:work:${n.previousSeriesId}`, previous_recurrence_series_source: "provider" } : {}) };
        await writeFile(path.join(root, "meetings", `${meetingId}.md`), `---\n${stringify(meeting).trimEnd()}\n---\n# Weekly planning\n`);
        await writeFile(path.join(root, "meetings", `${noteId}-note.md`), `---\n${stringify(note).trimEnd()}\n---\nlegacy ${n.seriesId}\n`);
        return noteId;
      };
      await mkdir(path.join(root, "meetings"), { recursive: true });
      const predecessorNoteId = await legacy({ externalId: "series-before", seriesId: "series-a", startsAt: "2026-10-05T08:00:00.000Z" });
      const successorNoteId = await legacy({ externalId: "series-after", seriesId: "series-b", previousSeriesId: "series-a", startsAt: "2026-10-12T08:00:00.000Z" });
      await new MarkdownObjectStore(root).prepareOperation(operationKinds.linkRecurringSeries, { seriesId: "fake:work:series-a", noteId: predecessorNoteId, now: timestamp }, uuidV7());
      await application.rebuildIndex();
      return { externalId: "series-before", successorNoteId };
    },
    act: async (application, { externalId }) => { await application.recoverOperations(); await application.createMeetingFromEvent(externalId!); },
    retry: (application, { externalId }) => application.createMeetingFromEvent(externalId!),
    check: (objects, { successorNoteId }) => expect(objects.find((object) => object.frontmatter.id === successorNoteId)?.frontmatter.previous_series_note_id).toBeUndefined()
  },
  [operationKinds.migrateRecurringNotes]: {
    setup: legacyRecurringNote,
    act: (application, { meetingId, noteId, noteHash }) => application.confirmRecurringMigration(meetingId!, { [noteId!]: noteHash! }),
    retry: (application, { meetingId, noteId, noteHash }) => application.confirmRecurringMigration(meetingId!, { [noteId!]: noteHash! }),
    check: (objects, { noteId }) => {
      expect(objects.find((object) => object.frontmatter.id === noteId)?.frontmatter.archived_at).toBeDefined();
      expect(objects.filter((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.recurrence_series_id)).toHaveLength(1);
    }
  },
  [operationKinds.supersedeDecision]: {
    setup: async (_root, application) => {
      const old = await application.createDecision({ title: "Budget is 10k" });
      return { id: old.frontmatter.id, hash: old.contentHash };
    },
    act: (application, { id, hash }) => application.supersedeDecision(id!, { title: "Budget is 12k" }, hash!)
  },
  [operationKinds.resolveOpenPoint]: {
    setup: async (_root, application) => {
      const point = await application.createOpenPoint({ title: "Which vendor?" });
      return { id: point.frontmatter.id, hash: point.contentHash };
    },
    act: (application, { id, hash }) => application.resolveOpenPointWithDecision(id!, { title: "Vendor A" }, hash!)
  },
  [operationKinds.applyPatch]: {
    setup: async (root, application) => {
      const task = await application.createEntity("task", { title: "Ship the pilot" });
      await dropInbox(root, "patches", "patch.md", { lifeos_patch: 1, draft_key: "patch-1", id: task.frontmatter.id, set: { priority: "High" } });
      return { taskId: task.frontmatter.id };
    },
    act: (application) => application.adoptDrafts(),
    retry: (application) => application.adoptDrafts(),
    check: (objects, { taskId }) => expect(objects.find((object) => object.frontmatter.id === taskId)?.frontmatter.priority).toBe("High")
  },
  [operationKinds.adoptDraft]: {
    setup: async (root) => {
      await dropInbox(root, "drafts", "idea.md", { lifeos_draft: 1, kind: "knowledge-note", draft_key: "idea-1", title: "Loyalty tiers lift basket size", sources: ["https://example.com/tiers"] }, "Tiers work.\n");
      return {};
    },
    act: (application) => application.adoptDrafts(),
    retry: (application) => application.adoptDrafts()
  },
  [operationKinds.adoptBatch]: {
    setup: async (root) => {
      await dropInbox(root, "drafts", "a.md", { lifeos_draft: 1, kind: "task", draft_key: "task-a", title: "Call the bank" });
      await dropInbox(root, "drafts", "b.md", { lifeos_draft: 1, kind: "decision", draft_key: "decision-b", title: "Go with vendor B" });
      return {};
    },
    act: (application) => application.adoptDrafts(),
    retry: (application) => application.adoptDrafts()
  },
  [operationKinds.purgeNote]: {
    setup: async (_root, application) => {
      const [event] = await application.listCalendarEvents();
      const workspace = await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nObsolete\n");
      const deleted = await application.deleteNote(workspace.note!.frontmatter.id, workspace.note!.contentHash);
      return { id: deleted.frontmatter.id, hash: deleted.contentHash };
    },
    act: (application, { id, hash }) => application.purgeNote(id!, hash!)
  },
  [operationKinds.quickCapture]: {
    setup: async () => ({}),
    act: (application) => application.quickCapture("Call the bank", { requestId: "capture-1" }),
    // The client re-sends the same request ID until it hears back.
    retry: (application) => application.quickCapture("Call the bank", { requestId: "capture-1" })
  }
};

/** What an object is, without its ID (IDs differ between runs). */
const shape = (object: LifeOSObject) => {
  const fm = object.frontmatter;
  return [fm.type, fm.title, fm.status ?? "", fm.deleted_at ? "deleted" : "", fm.archived_at ? "archived" : "", fm.merged_into_person_id ? "merged" : "", fm.superseded_by ? "superseded" : ""].join(" | ");
};
/**
 * Agent runs are left out: a crash part-way through an adoption batch truthfully ends as two runs (the recovered one
 * and the user's next batch), where a clean run has one. `runsAccountedFor` checks them instead.
 */
const shapes = (objects: LifeOSObject[]) => objects.filter((object) => !["audit-event", "agent-run"].includes(object.frontmatter.type)).map(shape).sort();
/** Every run an audit names has its agent-run record, and every Inbox adoption record is named by an audit: none lost, none stray. */
function runsAccountedFor(objects: LifeOSObject[], at: string) {
  const runs = objects.filter((object) => object.frontmatter.type === "agent-run");
  const named = new Set(objects.map((object) => (object.frontmatter.metadata as Record<string, unknown> | undefined)?.agent_run_id).filter((id): id is string => typeof id === "string"));
  expect.soft([...named].filter((id) => !runs.some((run) => run.frontmatter.id === id)), `${at}: runs named by audits but never recorded`).toEqual([]);
  expect.soft(runs.filter((run) => run.frontmatter.operation === "inbox-adoption" && !named.has(run.frontmatter.id)).map(shape), `${at}: adoption runs no audit names`).toEqual([]);
}
const auditActions = (objects: LifeOSObject[]) => objects.filter((object) => object.frontmatter.type === "audit-event").map((audit) => String(audit.frontmatter.action)).sort();
/** Two audits are the same event when they share action, object and the operation, review, draft or request they record. */
const auditKey = (audit: LifeOSObject) => {
  const metadata = (audit.frontmatter.metadata ?? {}) as Record<string, unknown>;
  return [audit.frontmatter.action, audit.frontmatter.object_id, metadata.operation_id, metadata.review_id, metadata.draft_key, metadata.request_id, metadata.content_hash].map(String).join(" ");
};

/** Runs one scenario in a new vault; with `crashAfter`, the process dies after that change and the app restarts. */
async function run(scenario: Scenario, crashAfter?: number) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-crash-every-"));
  roots.push(root);
  const calendar = scenario.calendar?.() ?? new MockCalendarConnector();
  const state = await scenario.setup(root, (await open(root, calendar)).application, calendar);

  const acting = await open(root, calendar);
  acting.store.arm(crashAfter);
  const acted = scenario.act(acting.application, state);
  // Without a crash the action must succeed; with one, it fails or reports "will retry". Either way the process dies here.
  if (crashAfter === undefined) await acted; else await acted.catch(() => undefined);
  const log = [...acting.store.log];

  const restarted = await open(root, calendar);
  if (crashAfter !== undefined) {
    await restarted.application.recoverOperations();
    await restarted.application.rebuildIndex();
    await scenario.retry?.(restarted.application, state);
    await restarted.application.rebuildIndex();
  }
  return { changes: log.length, log, state, store: restarted.store, application: restarted.application, objects: await restarted.store.list() };
}

describe("every journalled operation, crashed after each change it makes, recovers like a clean run (#160)", () => {
  it("covers every operation kind", () => {
    expect(Object.keys(scenarios).sort()).toEqual(Object.values(operationKinds).sort());
  });

  for (const [kind, scenario] of Object.entries(scenarios)) {
    it(`${kind}: same objects, every audit once, nothing left open`, async () => {
      const clean = await run(scenario);
      expect(clean.changes, "the clean run journals and writes").toBeGreaterThan(1);
      if (kind === operationKinds.migrateRecurringNotes) {
        expect(clean.log.indexOf("complete migrate-recurring-notes"), "migration closes before its audit").toBeLessThan(clean.log.indexOf("write audit meeting-note.migrated"));
      }
      if (kind === operationKinds.createMeeting) {
        expect(clean.log.indexOf("complete create-meeting"), "meeting creation closes before its audit").toBeLessThan(clean.log.indexOf("write audit meeting.created"));
      }
      scenario.check?.(clean.objects, clean.state);
      runsAccountedFor(clean.objects, `${kind}, clean run`);

      for (let crashAfter = 1; crashAfter <= clean.changes; crashAfter += 1) {
        const at = `${kind}, crash after change ${crashAfter} of ${clean.changes} (${clean.log[crashAfter - 1]})`;
        const { objects, state, store, application } = await run(scenario, crashAfter);
        expect.soft(await store.incompleteOperations(), `${at}: open operations`).toEqual([]);
        expect.soft((await application.health()).diagnostics.filter((line) => line.startsWith("Recovery of")), at).toEqual([]);
        const ids = objects.map((object) => object.frontmatter.id);
        expect.soft(ids.length - new Set(ids).size, `${at}: duplicate IDs`).toBe(0);
        expect.soft(shapes(objects), `${at}: objects`).toEqual(shapes(clean.objects));
        const keys = objects.filter((object) => object.frontmatter.type === "audit-event").map(auditKey);
        expect.soft(keys.length - new Set(keys).size, `${at}: duplicate audits\n${keys.sort().join("\n")}`).toBe(0);
        expect.soft(auditActions(objects), `${at}: audits`).toEqual(auditActions(clean.objects));
        runsAccountedFor(objects, at);
        scenario.check?.(objects, state);
      }
    }, 120_000);
  }
});
