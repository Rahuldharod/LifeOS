import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #122: every step that proposes a Review Item carries its source's sensitivity (ADR 0010) and, retried after a
// crash, never writes a second item.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

/** Crashes just after the store wrote the `crashAfter`-th Review Item (the file is on disk, the step did not finish). */
class CrashingStore extends MarkdownObjectStore {
  crashAfter = 0;
  override async write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }) {
    const written = await super.write(input);
    if (this.crashAfter && input.frontmatter.type === "review-item" && !input.expectedHash && --this.crashAfter === 0) throw new Error("power cut");
    return written;
  }
}

/** The mock AI, whose answer can come back reversed (as a real model's may on a retry) or repeat an item. */
class ReorderingAi extends MockAiProvider {
  reversed = false;
  repeatFirst = false;
  readonly knowledgeInputs: string[] = [];
  override async proposeKnowledgeNote(source: string) {
    this.knowledgeInputs.push(source);
    return super.proposeKnowledgeNote(source);
  }
  override async proposeMeetingOutputs(note: string) {
    const outputs = await super.proposeMeetingOutputs(note);
    const ordered = this.reversed ? outputs.reverse() : outputs;
    return this.repeatFirst ? [...ordered, { ...ordered[0]!, title: ` ${ordered[0]!.title.toUpperCase()} ` }] : ordered;
  }
}

async function vault(calendar: CalendarConnector = new MockCalendarConnector(), ai = new MockAiProvider()) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-review-factory-"));
  roots.push(root);
  const store = new CrashingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, ai, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

/** The app started again on the same data root after a crash. */
async function restart(root: string) {
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), new MockAiProvider(), "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return application;
}

async function drop(root: string, folder: "drafts" | "patches", name: string, content: string) {
  const target = path.join(root, "_inbox", folder, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}
const yaml = (fields: Record<string, unknown>, body = "") => `---\n${stringify(fields)}---\n${body}`;

const restrict = async (application: LifeOSApplication, object: LifeOSObject) => application.setSensitivity(object.frontmatter.id, "restricted", (await application.object(object.frontmatter.id)).contentHash);
const reviewsOf = (application: LifeOSApplication, type: string) => application.reviews().filter((review) => review.frontmatter.review_type === type);
const ofType = async (application: LifeOSApplication, type: string) => (await application.listObjects()).filter((object) => object.frontmatter.type === type);

async function meetingWithNote(application: LifeOSApplication) {
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  const note = await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  return { meeting: workspace.meeting, note };
}

describe("Review Items carry their source's sensitivity (#122, ADR 0010)", () => {
  it("proposals from a restricted meeting note are restricted, and so is the object accepted from one", async () => {
    const { application } = await vault();
    const { meeting, note } = await meetingWithNote(application);
    await restrict(application, note);

    const proposed = await application.processMeeting(meeting.frontmatter.id);

    expect(proposed).toHaveLength(3);
    for (const review of proposed) expect(review.frontmatter.sensitivity).toBe("restricted");
    const task = await application.acceptReviewItem(proposed.find((review) => review.frontmatter.target_object_type === "task")!.frontmatter.id);
    expect(task.frontmatter.sensitivity).toBe("restricted");
  });

  it("proposals from a normal meeting note stay normal", async () => {
    const { application } = await vault();
    const { meeting } = await meetingWithNote(application);
    for (const review of await application.processMeeting(meeting.frontmatter.id)) expect(review.frontmatter.sensitivity).toBeUndefined();
  });

  it("an extracted draft citing a restricted Source as evidence is restricted", async () => {
    const { root, application } = await vault();
    const source = await application.ingestTextSource("Board call", "Close the Lyon store.");
    await restrict(application, source);
    await drop(root, "drafts", "task.md", yaml({ lifeos_draft: 1, kind: "task", draft_key: "board-1", origin: "agent-extracted", title: "Close Lyon", confidence: "high", captured_at: "2026-10-04T09:15:00+02:00", evidence: [{ source: source.frontmatter.id, quote: "Close the Lyon store." }] }));

    await application.adoptDrafts();

    const review = reviewsOf(application, "create").find((item) => item.frontmatter.draft_key === "board-1")!;
    expect(review.frontmatter.sensitivity).toBe("restricted");
  });

  it("a change proposed to a restricted object is restricted", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Negotiate the Lyon lease");
    await restrict(application, task);
    await drop(root, "patches", "rename.md", yaml({ lifeos_patch: 1, draft_key: "p-1", origin: "agent-extracted", captured_at: "2026-10-04T10:00:00+02:00", id: task.frontmatter.id, set: { status: "Done" } }));

    await application.adoptDrafts();

    const [review] = reviewsOf(application, "update");
    expect(review!.frontmatter.sensitivity).toBe("restricted");
  });

  it("a link to resolve on a restricted object is restricted", async () => {
    const { root, application } = await vault();
    await drop(root, "drafts", "task.md", yaml({ lifeos_draft: 1, kind: "task", draft_key: "t-1", origin: "user-dictated", title: "Call the notary", sensitivity: "restricted", project: "Nowhere project", captured_at: "2026-10-04T09:15:00+02:00" }));

    await application.adoptDrafts();

    const [review] = reviewsOf(application, "link-resolution");
    expect(review!.frontmatter.sensitivity).toBe("restricted");
  });

  it("a merge suggestion involving a restricted person is restricted", async () => {
    const calendar = new FakeCalendar();
    const { application } = await vault(calendar);
    await application.createEntity("person", { title: "Marie Curie", sensitivity: "restricted" });
    const attendee: CalendarAttendee = { email: "marie.curie@example.com", displayName: "Marie Curie" };
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    calendar.events = [{ externalId: "e1", title: "Sync", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: ["Marie Curie"], attendeeDetails: [attendee] }];
    await application.createMeetingFromEvent("e1");

    await application.suggestPersonMerges();

    const [review] = reviewsOf(application, "person-merge");
    expect(review!.frontmatter.sensitivity).toBe("restricted");
  });
});

describe("retrying a proposing step after a crash writes no second Review Item (#122, ADR 0013)", () => {
  it("capture: the retried paste reuses its Source and its proposal", async () => {
    const { root, store, application: crashed } = await vault();
    store.crashAfter = 1;
    await expect(crashed.ingestTextSource("Research", "Local-first keeps files authoritative.")).rejects.toThrow("power cut");
    const application = await restart(root);

    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");

    const proposals = reviewsOf(application, "create").filter((review) => review.frontmatter.target_object_type === "knowledge-note");
    expect(proposals).toHaveLength(1);
    expect(await ofType(application, "source")).toHaveLength(1);
    // The proposal names the Agent run that made it, and that run is written once.
    const runs = await ofType(application, "agent-run");
    expect(runs.map((run) => run.frontmatter.id)).toEqual([proposals[0]!.frontmatter.agent_run_id]);
  });

  it("capture: a deliberate re-paste after the proposal was accepted makes a new Source and a new proposal", async () => {
    const { application } = await vault();
    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");
    const [first] = reviewsOf(application, "create");
    await application.acceptReviewItem(first!.frontmatter.id);

    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");

    expect(await ofType(application, "source")).toHaveLength(2);
    const pending = reviewsOf(application, "create").filter((review) => review.frontmatter.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.frontmatter.id).not.toBe(first!.frontmatter.id);
  });

  it("capture: a deliberate re-paste after the proposal was rejected makes a new Source and a new proposal", async () => {
    const { application } = await vault();
    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");
    const [first] = reviewsOf(application, "create");
    await application.rejectReviewItem(first!.frontmatter.id);

    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");

    expect(await ofType(application, "source")).toHaveLength(2);
    expect(reviewsOf(application, "create").filter((review) => review.frontmatter.status === "pending")).toHaveLength(1);
  });

  it("capture: the AI reads the pasted text as the Source keeps it, trimmed", async () => {
    const ai = new ReorderingAi();
    const { application } = await vault(new MockCalendarConnector(), ai);

    await application.ingestTextSource("Research", "\n  Local-first keeps files authoritative.  \n");

    expect(ai.knowledgeInputs).toEqual(["Local-first keeps files authoritative."]);
  });

  it("capture: pasting again while the proposal is still pending reuses the Source and its proposal", async () => {
    const { application } = await vault();
    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");

    await application.ingestTextSource("Research", "Local-first keeps files authoritative.");

    expect(await ofType(application, "source")).toHaveLength(1);
    expect(reviewsOf(application, "create")).toHaveLength(1);
  });

  it("meeting proposals: the retry finishes the set without repeating the items already written", async () => {
    const { root, store, application: crashed } = await vault();
    const { meeting } = await meetingWithNote(crashed);
    store.crashAfter = 2;
    await expect(crashed.processMeeting(meeting.frontmatter.id)).rejects.toThrow("power cut");
    const application = await restart(root);

    const retried = await application.processMeeting(meeting.frontmatter.id);

    expect(retried).toHaveLength(3);
    expect(reviewsOf(application, "create")).toHaveLength(3);
    expect(new Set(reviewsOf(application, "create").map((review) => review.frontmatter.operation_id)).size).toBe(3);
    expect(await ofType(application, "agent-run")).toHaveLength(1);
  });

  it("meeting proposals: a retry whose answer comes back reordered finds each item the first attempt wrote", async () => {
    const ai = new ReorderingAi();
    const { store, application } = await vault(new MockCalendarConnector(), ai);
    const { meeting } = await meetingWithNote(application);
    store.crashAfter = 1;
    await expect(application.processMeeting(meeting.frontmatter.id)).rejects.toThrow("power cut");
    ai.reversed = true;

    const retried = await application.processMeeting(meeting.frontmatter.id);

    expect(retried).toHaveLength(3);
    const titles = reviewsOf(application, "create").map((review) => review.frontmatter.title).sort();
    expect(titles).toEqual(["Confirm the meeting outcome", "Resolve unanswered meeting questions", "Review the captured meeting note"]);
  });

  it("meeting proposals: the same proposal twice in one answer is one item", async () => {
    const ai = new ReorderingAi();
    ai.repeatFirst = true;
    const { application } = await vault(new MockCalendarConnector(), ai);
    const { meeting } = await meetingWithNote(application);

    expect(await application.processMeeting(meeting.frontmatter.id)).toHaveLength(3);
    expect(reviewsOf(application, "create")).toHaveLength(3);
  });

  it("meeting proposals: processing an unchanged note again proposes nothing already decided; editing it proposes again", async () => {
    const { application } = await vault();
    const { meeting, note } = await meetingWithNote(application);
    const [first, second, third] = await application.processMeeting(meeting.frontmatter.id);
    await application.acceptReviewItem(first!.frontmatter.id);
    await application.rejectReviewItem(second!.frontmatter.id);
    await application.rejectReviewItem(third!.frontmatter.id);

    expect(await application.processMeeting(meeting.frontmatter.id)).toEqual([]);
    expect(reviewsOf(application, "create")).toHaveLength(3);

    await application.updateBody(note.frontmatter.id, "# Notes\n\nShip the pilot, then the rollout.\n", (await application.object(note.frontmatter.id)).contentHash);
    const again = await application.processMeeting(meeting.frontmatter.id);

    expect(again).toHaveLength(3);
    expect(reviewsOf(application, "create")).toHaveLength(6);
  });

  it("meeting proposals record when they were processed, not when the note was written, and keep their IDs", async () => {
    const { application } = await vault();
    const { meeting, note } = await meetingWithNote(application);
    const later = new Date(Date.parse(note.frontmatter.updated_at) + 2 * 3_600_000);
    vi.useFakeTimers({ toFake: ["Date"], now: later });
    try {
      const proposed = await application.processMeeting(meeting.frontmatter.id);

      for (const review of proposed) expect(review.frontmatter.created_at).toBe(later.toISOString());
      const [run] = await ofType(application, "agent-run");
      expect(run!.frontmatter.started_at).toBe(later.toISOString());
      expect(run!.frontmatter.completed_at).toBe(later.toISOString());
      vi.setSystemTime(new Date(later.getTime() + 3_600_000));
      expect((await application.processMeeting(meeting.frontmatter.id)).map((review) => review.frontmatter.id)).toEqual(proposed.map((review) => review.frontmatter.id));
    } finally { vi.useRealTimers(); }
  });

  it("meeting proposals: retried without a restart, the same items come back", async () => {
    const { store, application } = await vault();
    const { meeting } = await meetingWithNote(application);
    store.crashAfter = 1;
    await expect(application.processMeeting(meeting.frontmatter.id)).rejects.toThrow("power cut");

    await application.processMeeting(meeting.frontmatter.id);

    expect(reviewsOf(application, "create")).toHaveLength(3);
  });
});
