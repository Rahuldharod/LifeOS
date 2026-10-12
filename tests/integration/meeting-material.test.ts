import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { seedLegacySharedNote } from "./legacy-shared-note.js";

// Issue #45 (PRD "Adoption of meeting material"): a `meeting-material` draft from the enrichment run adds
// Sources to the meeting, proposes a summary and outputs with evidence, and flags what the notes missed.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const startedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
const endedAt = new Date(Date.now() - 4 * 3_600_000).toISOString();
const event = (externalId: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  externalId, calendarId: "work", calendarName: "Work", title: `Q3 sync ${externalId}`, startsAt: startedAt, endsAt: endedAt, timezone: "Europe/Paris",
  attendees: ["Joel Martin"], attendeeDetails: [{ email: "joel@client.example", displayName: "Joel Martin" }],
  projectName: "Retail media", clientName: "Carrefour", productName: "AIR", ...extra
});

class FakeCalendar implements CalendarConnector {
  readonly provider = "google";
  failure?: Error;
  constructor(public events: CalendarEvent[]) {}
  async listEvents(from: Date, to: Date) {
    if (this.failure) throw this.failure;
    return this.events.filter((candidate) => Date.parse(candidate.startsAt) < to.getTime() && Date.parse(candidate.endsAt) > from.getTime());
  }
}

async function vault(events: CalendarEvent[] = [event("evt-1")], storeFactory?: (root: string) => MarkdownObjectStore) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-material-"));
  roots.push(root);
  const calendar = new FakeCalendar(events);
  const objects = storeFactory?.(root) ?? new MarkdownObjectStore(root);
  const application = new LifeOSApplication(objects, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, calendar, application, objects };
}

async function dropDraft(root: string, name: string, content: string) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const sourcesYaml = (types: string[]) => types.map((type) => `
  - source_type: ${type}
    url: https://example.test/${type}/1
    external_id: ${type}-1
    occurred_at: ${startedAt}`).join("");

const proposalsYaml = `
proposals:
  - kind: task
    title: Send the deck to Joel
    confidence: high
    missed_in_notes: true
    due_on: 2026-10-10
    evidence:
      - source: meet-transcript-1
        locator: "00:12:30"
        quote: "Rahul: I will send the deck"
  - kind: decision
    title: Go with vendor B
    confidence: medium
    missed_in_notes: false
    evidence:
      - source: https://example.test/gong-call/1
        locator: "14:02"`;

/** A meeting-material draft as the enrichment skill writes it; the body is the proposed summary. */
const material = (options: { key: string; meeting?: string; sources?: string[]; proposals?: string; summary?: string; extra?: string }) => `---
lifeos_draft: 1
kind: meeting-material
draft_key: ${options.key}
origin: agent-extracted
title: Material for Q3 sync
captured_at: 2026-10-04T09:15:00+02:00
meeting: ${options.meeting ?? "evt-1"}
sources:${sourcesYaml(options.sources ?? ["meet-transcript", "gong-call"])}
${options.proposals ?? proposalsYaml}
${options.extra ?? ""}
---
${options.summary ?? "Joel confirmed vendor B. Rahul owes the deck.\n"}`;

/** The Legacy shared Note (ADR 0019) holding these occurrences, with each occurrence's workspace as the app reads it (#172). */
async function legacyWorkspaces(root: string, application: LifeOSApplication, occurrences: Array<[CalendarEvent, string]>) {
  const { items } = await seedLegacySharedNote(root, "google", occurrences.map(([occurrence, body]) => ({ event: occurrence, body })));
  await application.rebuildIndex();
  return Promise.all(occurrences.map(([occurrence]) => application.meetingWorkspace(items.find((item) => item.event === occurrence)!.meetingId)));
}

const legacyWorkspace = async (root: string, application: LifeOSApplication, occurrence: CalendarEvent, body: string) => (await legacyWorkspaces(root, application, [[occurrence, body]]))[0]!;

const ofType = (application: LifeOSApplication, type: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === type && !object.frontmatter.deleted_at));
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) };

describe("meeting-material adoption", () => {
  it("enriches a new recurring occurrence on its Meeting without creating a Note or a section (#151, #172)", async () => {
    const occurrence = event("recurring-new", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    await dropDraft(root, "material.md", material({
      key: "materials-only", meeting: occurrence.externalId, sources: ["drive-doc"], proposals: "proposals: []", summary: "",
      extra: `recurrence_occurrence_id: google:work:weekly-series:${startedAt}`
    }));

    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    expect(await ofType(application, "meeting-note")).toHaveLength(0);
    expect(await ofType(application, "source")).toHaveLength(1);
    expect(await ofType(application, "meeting")).toHaveLength(1);
  });

  it("replays a recurring draft without duplicating its Meeting or Source (#151, #172)", async () => {
    const occurrence = event("recurring-replay", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    const content = material({
      key: "recurring-replay", meeting: occurrence.externalId, sources: ["drive-doc"], proposals: "proposals: []", summary: "",
      extra: `recurrence_occurrence_id: google:work:weekly-series:${startedAt}`
    });
    await dropDraft(root, "first.md", content);
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    await dropDraft(root, "retry.md", content);
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("duplicate");

    expect(await ofType(application, "source")).toHaveLength(1);
    expect(await ofType(application, "meeting")).toHaveLength(1);
    expect(await ofType(application, "meeting-note")).toHaveLength(0);
  });

  it("accepts an older draft that still carries occurrence_section_id and ignores it (#176)", async () => {
    const occurrence = event("recurring-old-draft", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    await dropDraft(root, "old-format.md", material({
      key: "old-format", meeting: occurrence.externalId, sources: ["drive-doc"], proposals: "proposals: []", summary: "",
      extra: `occurrence_section_id: occurrence-from-an-older-work-order\nrecurrence_occurrence_id: google:work:weekly-series:${startedAt}`
    }));

    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    expect(await ofType(application, "source")).toHaveLength(1);
    expect(await ofType(application, "meeting-note")).toHaveLength(0);
  });

  it("writes nothing into a Legacy shared Note: Sources, summary and proposals stay on the Meeting (#176, ADR 0021)", async () => {
    const occurrence = event("recurring-legacy", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    const workspace = await legacyWorkspace(root, application, occurrence, "Original user notes.\n");
    const before = (await application.object(workspace.note!.frontmatter.id)).contentHash;
    await dropDraft(root, "legacy.md", material({
      key: "legacy", meeting: workspace.meeting.frontmatter.id, sources: ["drive-doc"], proposals: "proposals: []", summary: "Legacy-week summary.\n",
      extra: `recurrence_occurrence_id: google:work:weekly-series:${startedAt}\nsummary_evidence:\n  - source: drive-doc-1\n    locator: "page 1"`
    }));

    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    const note = await application.object(workspace.note!.frontmatter.id);
    expect(note.contentHash).toBe(before);
    expect(note.body).not.toContain("lifeos:materials");
    expect((await ofType(application, "source")).map((source) => source.frontmatter.meeting_id)).toEqual([workspace.meeting.frontmatter.id]);
    expect(application.reviews().filter((review) => review.frontmatter.review_type === "summary")).toHaveLength(1);
  });

  it("verifies a recurring draft's occurrence, then writes Sources, summary and proposals to that Meeting only (#176)", async () => {
    const occurrence = event("recurring-1", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    const workspace = await application.createMeetingFromEvent(occurrence.externalId, range.from, range.to, "work", "User-authored occurrence notes.\n");
    const occurrenceId = `google:work:weekly-series:${startedAt}`;
    const noteBefore = workspace.note!;

    await dropDraft(root, "wrong.md", material({
      key: "wrong-occurrence", meeting: workspace.meeting.frontmatter.id, proposals: "proposals: []", summary: "",
      extra: "recurrence_occurrence_id: google:work:weekly-series:2020-01-01T00:00:00.000Z"
    }));
    const refused = await application.adoptDrafts();
    expect(refused.drafts[0]).toMatchObject({ outcome: "failed", reason: expect.stringContaining("recurrence_occurrence_id") });
    expect(await ofType(application, "source")).toHaveLength(0);

    const correct = material({
      key: "right-occurrence", meeting: workspace.meeting.frontmatter.id, summary: "Occurrence-specific summary.\n",
      extra: `recurrence_occurrence_id: ${occurrenceId}\nsummary_evidence:\n  - source: https://example.test/meet-transcript/1\n    locator: "00:12:30"`
    }).replace(`occurred_at: ${startedAt}`, `occurred_at: ${startedAt}\n    retrieved_at: 2026-10-04T09:10:00+02:00\n    provider_revision: drive-revision-7`);
    await dropDraft(root, "right.md", correct);
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");

    const [source] = (await ofType(application, "source")).filter((candidate) => candidate.frontmatter.source_type === "meet-transcript");
    expect(source!.frontmatter).toMatchObject({ retrieved_at: "2026-10-04T07:10:00.000Z", provider_revision: "drive-revision-7", meeting_id: workspace.meeting.frontmatter.id });
    // The Note is exactly as the user left it: no Materials block, no section.
    const storedNote = await application.object(noteBefore.frontmatter.id);
    expect(storedNote.contentHash).toBe(noteBefore.contentHash);
    expect(storedNote.body).not.toContain("lifeos:materials");
    const summaries = application.reviews().filter((review) => review.frontmatter.review_type === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.frontmatter).toMatchObject({ recurrence_occurrence_id: occurrenceId, source_meeting_id: workspace.meeting.frontmatter.id });
    expect(summaries[0]!.frontmatter.occurrence_section_id).toBeUndefined();
    expect(application.reviewEvidence(summaries[0]!.frontmatter.id).summary).toEqual([
      expect.objectContaining({ resolved: true, source_id: source!.frontmatter.id, locator: "00:12:30" })
    ]);
    const proposals = application.reviews().filter((review) => review.frontmatter.review_type === "create");
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((review) => review.frontmatter.recurrence_occurrence_id === occurrenceId && review.frontmatter.occurrence_section_id === undefined)).toBe(true);

    // Accepting the summary writes the Meeting body; the Note stays untouched.
    await application.acceptReviewItem(summaries[0]!.frontmatter.id);
    expect(application.object(workspace.meeting.frontmatter.id).body).toContain("Occurrence-specific summary.");
    expect((await application.object(noteBefore.frontmatter.id)).contentHash).toBe(noteBefore.contentHash);
  });

  it("refuses recurring evidence that names a Source not linked to this occurrence (#176)", async () => {
    const occurrence = event("recurring-locator", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    const workspace = await application.createMeetingFromEvent(occurrence.externalId, range.from, range.to, "work", "Target notes.\n");
    await dropDraft(root, "wrong-source.md", material({
      key: "wrong-source", meeting: workspace.meeting.frontmatter.id, proposals: "proposals: []", summary: "Wrong evidence.\n",
      extra: `recurrence_occurrence_id: google:work:weekly-series:${startedAt}\nsummary_evidence:\n  - source: https://example.test/someone-elses-source\n    locator: "00:12:30"`
    }));

    const result = (await application.adoptDrafts()).drafts[0]!;
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("must name a Source linked to this occurrence") });
    expect(await ofType(application, "source")).toHaveLength(0);
    expect(application.reviews()).toHaveLength(0);
  });

  it("links one external Source to several recurring occurrences without duplication, each in its own Note's Meeting (#176)", async () => {
    const olderStart = new Date(Date.parse(startedAt) - 3 * 3_600_000).toISOString();
    const olderEnd = new Date(Date.parse(endedAt) - 3 * 3_600_000).toISOString();
    const occurrences = [
      event("recurring-old", { title: "Q3 sync weekly", startsAt: olderStart, endsAt: olderEnd, seriesId: "weekly-series", originalOccurrenceStartsAt: olderStart }),
      event("recurring-new", { title: "Q3 sync weekly", seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt })
    ];
    const { root, application } = await vault(occurrences);
    const oldWorkspace = await application.createMeetingFromEvent("recurring-old", range.from, range.to, "work", "Older notes.\n");
    const newWorkspace = await application.createMeetingFromEvent("recurring-new", range.from, range.to, "work", "Newer notes.\n");
    expect(oldWorkspace.note!.frontmatter.id).not.toBe(newWorkspace.note!.frontmatter.id);

    for (const [name, workspace, at] of [["old", oldWorkspace, olderStart], ["new", newWorkspace, startedAt]] as const) {
      await dropDraft(root, `${name}.md`, material({
        key: `shared-${name}`, meeting: workspace.meeting.frontmatter.id, sources: ["drive-doc"], proposals: "proposals: []", summary: name === "new" ? "Shared-source summary.\n" : "",
        extra: `recurrence_occurrence_id: google:work:weekly-series:${at}${name === "new" ? `\nsummary_evidence:\n  - source: drive-doc-1\n    locator: "page 1"` : ""}`
      }));
      const result = (await application.adoptDrafts()).drafts[0]!;
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "adopted" });
    }

    const sources = await ofType(application, "source");
    expect(sources).toHaveLength(1);
    const refreshedOld = await application.object(oldWorkspace.meeting.frontmatter.id);
    const refreshedNew = await application.object(newWorkspace.meeting.frontmatter.id);
    expect([refreshedOld, refreshedNew].filter((meeting) => (meeting.frontmatter.source_ids as string[] | undefined)?.includes(sources[0]!.frontmatter.id))).toHaveLength(1);
    for (const workspace of [oldWorkspace, newWorkspace]) expect((await application.object(workspace.note!.frontmatter.id)).contentHash).toBe(workspace.note!.contentHash);
    expect((refreshedNew.frontmatter.source_ids as string[])).toContain(sources[0]!.frontmatter.id);
    const summary = application.reviews().find((review) => review.frontmatter.source_meeting_id === refreshedNew.frontmatter.id)!;
    expect(application.reviewEvidence(summary.frontmatter.id).summary).toEqual([expect.objectContaining({ resolved: true, source_id: sources[0]!.frontmatter.id })]);
  });

  it("creates the meeting (not the note) from the calendar event, upserts sources and proposes summary and outputs", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "material.md", material({ key: "enrich-evt-1" }));

    const batch = await application.adoptDrafts();

    expect(batch.drafts[0]).toMatchObject({ outcome: "adopted", filedAs: "_inbox/processed/material.md" });
    const [meeting] = await ofType(application, "meeting");
    expect(meeting).toBeDefined();
    expect(meeting!.frontmatter).toMatchObject({ origin: "calendar", enrichment_state: "partial", enrichment_missing_material: ["meet-recording", "gong-summary-email"] });
    expect(meeting!.frontmatter.external_refs).toEqual([expect.objectContaining({ external_id: "evt-1", calendar_id: "work" })]);
    // The canonical note is still only created on the user's first edit.
    expect(await ofType(application, "meeting-note")).toHaveLength(0);

    const sources = await ofType(application, "source");
    expect(sources.map((source) => source.frontmatter.source_type).sort()).toEqual(["gong-call", "meet-transcript"]);
    const transcript = sources.find((source) => source.frontmatter.source_type === "meet-transcript")!;
    const gong = sources.find((source) => source.frontmatter.source_type === "gong-call")!;
    expect(transcript.frontmatter).toMatchObject({ provider: "google-drive", external_id: "meet-transcript-1", url: "https://example.test/meet-transcript/1", occurred_at: startedAt, meeting_id: meeting!.frontmatter.id, origin: "agent-extracted", ingestion_status: "captured" });
    expect(gong.frontmatter).toMatchObject({ provider: "gong", meeting_id: meeting!.frontmatter.id });
    expect(transcript.relativePath.startsWith("sources/")).toBe(true);

    const reviews = application.reviews();
    const summary = reviews.find((review) => review.frontmatter.review_type === "summary")!;
    expect(summary.frontmatter).toMatchObject({ target_object_type: "meeting", target_object_id: meeting!.frontmatter.id, source_meeting_id: meeting!.frontmatter.id, status: "pending", proposed_fields: { summary: "Joel confirmed vendor B. Rahul owes the deck." } });
    expect(summary.frontmatter.source_ids).toEqual(expect.arrayContaining([transcript.frontmatter.id, gong.frontmatter.id]));

    const task = reviews.find((review) => review.frontmatter.review_type === "create" && review.frontmatter.target_object_type === "task")!;
    const decision = reviews.find((review) => review.frontmatter.review_type === "create" && review.frontmatter.target_object_type === "decision")!;
    expect(task.frontmatter).toMatchObject({ missed_in_notes: true, confidence_label: "High", source_meeting_id: meeting!.frontmatter.id, source_ids: [transcript.frontmatter.id], origin: "agent-extracted" });
    expect(decision.frontmatter).toMatchObject({ missed_in_notes: false, source_ids: [gong.frontmatter.id] });
    // Inherits the meeting's project, client, product and people.
    for (const review of [task, decision, summary]) {
      expect(review.frontmatter).toMatchObject({ primary_project_id: meeting!.frontmatter.primary_project_id, primary_client_id: meeting!.frontmatter.primary_client_id, primary_product_id: meeting!.frontmatter.primary_product_id });
    }
    expect(meeting!.frontmatter.primary_project_id).toBeTruthy();
    expect((task.frontmatter.proposed_fields as Record<string, unknown>).people_ids).toEqual(meeting!.frontmatter.attendee_ids);
    expect((meeting!.frontmatter.attendee_ids as string[]).length).toBe(1);
    expect(application.reviewEvidence(task.frontmatter.id).title).toEqual([expect.objectContaining({ resolved: true, source_id: transcript.frontmatter.id, locator: "00:12:30" })]);

    expect(batch.drafts[0]!.objectIds).toEqual(expect.arrayContaining([meeting!.frontmatter.id, transcript.frontmatter.id, gong.frontmatter.id, summary.frontmatter.id, task.frontmatter.id, decision.frontmatter.id]));
    const sidecar = await frontmatterOf(path.join(root, "_inbox", "processed", "material.result.md"));
    expect(sidecar).toMatchObject({ outcome: "adopted", draft_key: "enrich-evt-1" });

    // The first edit later creates the note on the same meeting, never a second meeting.
    const workspace = await application.createMeetingFromEvent("evt-1", range.from, range.to, "work", "# Notes\n\nMy own notes.\n");
    expect(workspace.meeting.frontmatter.id).toBe(meeting!.frontmatter.id);
    expect(await ofType(application, "meeting")).toHaveLength(1);
    expect(workspace.reviews.map((review) => review.frontmatter.id)).toEqual(expect.arrayContaining([summary.frontmatter.id, task.frontmatter.id]));
  });

  it("accepting the summary writes the Summary section of the meeting body, never the meeting-note", async () => {
    const { root, application } = await vault();
    const { meeting, note } = await application.createMeetingFromEvent("evt-1", range.from, range.to, "work", "# Notes\n\nMy own notes.\n");
    await dropDraft(root, "material.md", material({ key: "enrich-evt-1", meeting: meeting.frontmatter.id }));
    await application.adoptDrafts();
    const summary = application.reviews().find((review) => review.frontmatter.review_type === "summary")!;

    const updated = await application.acceptReviewItem(summary.frontmatter.id);

    expect(updated.frontmatter.id).toBe(meeting.frontmatter.id);
    const stored = await application.object(meeting.frontmatter.id);
    expect(stored.body).toContain("## Summary\n\nJoel confirmed vendor B. Rahul owes the deck.\n");
    expect(stored.body.startsWith(meeting.body.trimEnd())).toBe(true);
    expect((await application.object(note!.frontmatter.id)).body).toBe("# Notes\n\nMy own notes.\n");
    expect(application.reviews().find((review) => review.frontmatter.id === summary.frontmatter.id)!.frontmatter).toMatchObject({ status: "accepted", resolved_object_id: meeting.frontmatter.id });
    // Accepting again is a no-op.
    const again = await application.acceptReviewItem(summary.frontmatter.id);
    expect(again.frontmatter.revision).toBe(stored.frontmatter.revision);
    expect((await ofType(application, "meeting"))).toHaveLength(1);
  });

  it("refuses to accept a summary for a meeting restricted after it was raised, by the meeting or its note (#63)", async () => {
    const { root, application } = await vault([event("evt-1"), event("evt-2")]);
    const first = await application.createMeetingFromEvent("evt-1", range.from, range.to, "work", "# Notes\n");
    const second = await application.createMeetingFromEvent("evt-2", range.from, range.to, "work", "# Notes\n");
    await dropDraft(root, "one.md", material({ key: "one", meeting: first.meeting.frontmatter.id }));
    await dropDraft(root, "two.md", material({ key: "two", meeting: second.meeting.frontmatter.id }));
    await application.adoptDrafts();
    const summaryFor = (meetingId: string) => application.reviews().find((review) => review.frontmatter.review_type === "summary" && review.frontmatter.target_object_id === meetingId)!;
    const firstSummary = summaryFor(first.meeting.frontmatter.id);
    const secondSummary = summaryFor(second.meeting.frontmatter.id);
    await application.setSensitivity(first.note!.frontmatter.id, "restricted", (await application.object(first.note!.frontmatter.id)).contentHash);
    await application.setSensitivity(second.meeting.frontmatter.id, "restricted", (await application.object(second.meeting.frontmatter.id)).contentHash);

    for (const [review, meetingId] of [[firstSummary, first.meeting.frontmatter.id], [secondSummary, second.meeting.frontmatter.id]] as const) {
      const before = await application.object(meetingId);
      await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow("This meeting is now restricted, so its summary cannot be accepted");
      const after = await application.object(meetingId);
      expect(after.body).toBe(before.body);
      expect(after.body).not.toContain("## Summary");
      expect(application.reviews().find((item) => item.frontmatter.id === review.frontmatter.id)!.frontmatter.status).toBe("pending");
    }
  });

  it("a later summary replaces the Summary section rather than adding a second one", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "one.md", material({ key: "one" }));
    await application.adoptDrafts();
    await application.acceptReviewItem(application.reviews().find((review) => review.frontmatter.review_type === "summary")!.frontmatter.id);
    await dropDraft(root, "two.md", material({ key: "two", summary: "A better summary.\n" }));
    await application.adoptDrafts();
    const pending = application.reviews().filter((review) => review.frontmatter.review_type === "summary" && review.frontmatter.status === "pending");
    expect(pending).toHaveLength(1);
    await application.acceptReviewItem(pending[0]!.frontmatter.id);
    const [listed] = await ofType(application, "meeting");
    const meeting = await application.object(listed!.frontmatter.id);
    expect(meeting!.body.match(/## Summary/g)).toHaveLength(1);
    expect(meeting!.body).toContain("## Summary\n\nA better summary.\n");
    expect(meeting!.body).not.toContain("owes the deck");
  });

  it("a summary with its own headings is written once on retry, fully replaced by a newer one, and never touches the note (#66)", async () => {
    const { root, application } = await vault();
    const { meeting, note } = await application.createMeetingFromEvent("evt-1", range.from, range.to, "work", "# Notes\n\nMy own notes.\n");
    const headed = "Vendor B chosen.\n\n## Risks\n\n- Budget slips\n\n# Appendix\n\nOld timeline.\n";
    await dropDraft(root, "one.md", material({ key: "one", meeting: meeting.frontmatter.id, summary: headed }));
    await application.adoptDrafts();
    const first = application.reviews().find((review) => review.frontmatter.review_type === "summary")!;
    await application.acceptReviewItem(first.frontmatter.id);
    const accepted = await application.object(meeting.frontmatter.id);
    expect(accepted.body.match(/## Risks/g)).toHaveLength(1);

    // Crash after the meeting write, before the Review Item was marked accepted: the retry finds the section in place.
    const reviewFile = path.join(root, "review-items", (await readdir(path.join(root, "review-items"))).find((name) => name.includes(first.frontmatter.id))!);
    await writeFile(reviewFile, (await readFile(reviewFile, "utf8")).replace(/^status: accepted$/m, "status: pending"));
    await application.rebuildIndex();
    expect(application.reviews().find((review) => review.frontmatter.id === first.frontmatter.id)!.frontmatter.status).toBe("pending");
    await application.acceptReviewItem(first.frontmatter.id);
    const retried = await application.object(meeting.frontmatter.id);
    expect(retried.body).toBe(accepted.body);
    expect(retried.body.match(/## Summary/g)).toHaveLength(1);
    expect(retried.body.match(/## Risks/g)).toHaveLength(1);

    // A newer summary replaces every part of the older one; the user's text around it is unchanged.
    await dropDraft(root, "two.md", material({ key: "two", meeting: meeting.frontmatter.id, summary: "A better summary.\n\n## Next\n\n- Ship\n" }));
    await application.adoptDrafts();
    const second = application.reviews().find((review) => review.frontmatter.review_type === "summary" && review.frontmatter.status === "pending")!;
    await application.acceptReviewItem(second.frontmatter.id);
    const replaced = await application.object(meeting.frontmatter.id);
    for (const fragment of ["Vendor B chosen", "## Risks", "Budget slips", "# Appendix", "Old timeline"]) expect(replaced.body).not.toContain(fragment);
    expect(replaced.body).toContain("## Summary\n\nA better summary.\n\n## Next\n\n- Ship\n");
    expect(replaced.body.startsWith(meeting.body.trimEnd())).toBe(true);
    expect((await application.object(note!.frontmatter.id)).body).toBe("# Notes\n\nMy own notes.\n");
  });

  it("re-running on the same meeting never duplicates sources or proposals, and completes the state", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "first.md", material({ key: "enrich-evt-1-a" }));
    await application.adoptDrafts();
    const rejected = application.reviews().find((review) => review.frontmatter.target_object_type === "decision")!;
    await application.rejectReviewItem(rejected.frontmatter.id);
    const before = application.reviews().length;

    // A second run finds the remaining material; same proposals (one re-worded only in case), same summary.
    await dropDraft(root, "second.md", material({ key: "enrich-evt-1-b", sources: ["meet-transcript", "gong-call", "meet-recording", "gong-summary-email"], proposals: proposalsYaml.replace("Send the deck to Joel", "send the deck to joel") }));
    const batch = await application.adoptDrafts();

    expect(batch.drafts[0]!.outcome).toBe("adopted");
    expect(await ofType(application, "source")).toHaveLength(4);
    expect(application.reviews()).toHaveLength(before);
    expect(application.reviews().find((review) => review.frontmatter.id === rejected.frontmatter.id)!.frontmatter.status).toBe("rejected");
    const [meeting] = await ofType(application, "meeting");
    expect(meeting!.frontmatter.enrichment_state).toBe("enriched");
    expect(meeting!.frontmatter.enrichment_missing_material).toEqual([]);
    expect(await ofType(application, "meeting")).toHaveLength(1);

    // Re-sending the identical draft is the usual no-op duplicate.
    await dropDraft(root, "again.md", material({ key: "enrich-evt-1-b", sources: ["meet-transcript", "gong-call", "meet-recording", "gong-summary-email"], proposals: proposalsYaml.replace("Send the deck to Joel", "send the deck to joel") }));
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("duplicate");
  });

  it("a different summary replaces a still-pending one instead of adding a second", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "one.md", material({ key: "one" }));
    await application.adoptDrafts();
    await dropDraft(root, "two.md", material({ key: "two", summary: "Fuller summary.\n" }));
    await application.adoptDrafts();
    const summaries = application.reviews().filter((review) => review.frontmatter.review_type === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.frontmatter.proposed_fields).toEqual({ summary: "Fuller summary." });
  });

  it("works for a meeting without a note, by meeting ID, with no summary", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "a.md", material({ key: "a", sources: ["meet-transcript"], proposals: "proposals: []", summary: "" }));
    await application.adoptDrafts();
    const [meeting] = await ofType(application, "meeting");
    await dropDraft(root, "b.md", material({ key: "b", meeting: meeting!.frontmatter.id, sources: ["meet-recording"], proposals: "proposals: []", summary: "" }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("adopted");
    expect(application.reviews()).toHaveLength(0);
    expect(await ofType(application, "meeting-note")).toHaveLength(0);
    expect((await application.object(meeting!.frontmatter.id)).frontmatter).toMatchObject({ enrichment_state: "partial", enrichment_missing_material: ["gong-call", "gong-summary-email"] });
  });

  it("counts material the agent checked and found not to exist, so a meeting without Gong can be enriched", async () => {
    const { root, application, calendar } = await vault();
    await dropDraft(root, "a.md", material({ key: "a", sources: ["meet-transcript", "meet-recording"], proposals: "proposals: []", extra: "unavailable: [gong-call, gong-summary-email]" }));
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    const [meeting] = await ofType(application, "meeting");
    expect(meeting!.frontmatter).toMatchObject({ enrichment_state: "enriched", enrichment_missing_material: [], enrichment_unavailable_material: ["gong-call", "gong-summary-email"] });
    // A later Work Order never asks for it again.
    calendar.events = [event("evt-1"), event("evt-2")];
    const request = await application.requestEnrichment();
    expect(request.meetings.map((entry) => entry.calendarEventId)).not.toContain("evt-1");
  });

  it("refuses unknown or contradictory unavailable material", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "a.md", material({ key: "a", sources: ["gong-call"], proposals: "proposals: []", extra: "unavailable: [gong-call, fax]" }));
    const reason = (await application.adoptDrafts()).drafts[0]!.reason!;
    expect(reason).toContain('unavailable: unknown material "fax"');
    expect(reason).toContain("unavailable: gong-call is also listed in sources");
  });

  it("re-requests partial meetings only for material not yet marked unavailable", async () => {
    const { root, application, calendar } = await vault();
    await dropDraft(root, "a.md", material({ key: "a", sources: ["meet-transcript"], proposals: "proposals: []", extra: "unavailable: [gong-call]" }));
    await application.adoptDrafts();
    calendar.events = [event("evt-1")];
    const request = await application.requestEnrichment();
    expect(request.meetings.find((entry) => entry.calendarEventId === "evt-1")?.missingMaterial).toEqual(["meet-recording", "gong-summary-email"]);
  });

  it("links an existing source by provider + external ID instead of creating another", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "a.md", material({ key: "a", sources: ["drive-doc"], proposals: "proposals: []" }));
    await application.adoptDrafts();
    const [meeting] = await ofType(application, "meeting");
    // Same external ID from another provider is a different source.
    await dropDraft(root, "b.md", material({ key: "b", sources: ["drive-doc"], proposals: "proposals: []", extra: "" }).replace("source_type: drive-doc", "source_type: drive-doc\n    provider: dropbox"));
    await application.adoptDrafts();
    const sources = await ofType(application, "source");
    expect(sources.map((source) => source.frontmatter.provider).sort()).toEqual(["dropbox", "google-drive"]);
    expect(sources.every((source) => source.frontmatter.meeting_id === meeting!.frontmatter.id)).toBe(true);
  });

  it("a first edit racing the adoption still yields one meeting, with the user's note", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "material.md", material({ key: "race" }));
    const [batch, workspace] = await Promise.all([application.adoptDrafts(), application.createMeetingFromEvent("evt-1", range.from, range.to, "work", "# Notes\n\nTyped fast.\n")]);
    expect(batch.drafts[0]!.outcome).toBe("adopted");
    expect(await ofType(application, "meeting")).toHaveLength(1);
    expect(workspace.note!.body).toBe("# Notes\n\nTyped fast.\n");
    expect(await ofType(application, "meeting-note")).toHaveLength(1);
  });

  it("a newer summary drawing on a restricted Source makes the pending summary restricted (#122, ADR 0018)", async () => {
    const { root, application } = await vault([event("evt-1"), event("evt-2")]);
    await dropDraft(root, "other.md", material({ key: "other", meeting: "evt-2", sources: ["gong-call"], proposals: "proposals: []" }));
    await application.adoptDrafts();
    const [gong] = await ofType(application, "source");
    await application.setSensitivity(gong!.frontmatter.id, "restricted", gong!.contentHash);
    await dropDraft(root, "one.md", material({ key: "one", sources: ["meet-transcript"], proposals: "proposals: []" }));
    await application.adoptDrafts();
    const summaryOf = () => application.reviews().filter((review) => review.frontmatter.review_type === "summary" && review.frontmatter.status === "pending" && ["one", "two"].includes(String(review.frontmatter.draft_key)));
    expect(summaryOf()).toHaveLength(1);
    expect(summaryOf()[0]!.frontmatter.sensitivity).toBeUndefined();

    await dropDraft(root, "two.md", material({ key: "two", sources: ["meet-transcript", "gong-call"], proposals: "proposals: []", summary: "Fuller summary.\n" }));
    await application.adoptDrafts();

    expect(summaryOf()).toHaveLength(1);
    const [summary] = summaryOf();
    expect(summary!.frontmatter.source_ids).toContain(gong!.frontmatter.id);
    expect(summary!.frontmatter.sensitivity).toBe("restricted");
  });

  it("recalculates a revised recurring summary from its new restricted evidence (#151, ADR 0018)", async () => {
    const occurrence = event("recurring-sensitive", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    const workspace = await application.createMeetingFromEvent(occurrence.externalId, range.from, range.to, "work", "User notes.\n");
    const occurrenceFields = `recurrence_occurrence_id: google:work:weekly-series:${startedAt}`;
    await dropDraft(root, "first-summary.md", material({
      key: "sensitive-first", meeting: workspace.meeting.frontmatter.id, sources: ["drive-doc"], proposals: "proposals: []", summary: "First summary.\n",
      extra: `${occurrenceFields}\nsummary_evidence:\n  - source: drive-doc-1\n    locator: "page 1"`
    }));
    await application.adoptDrafts();
    const [driveDoc] = await ofType(application, "source");
    await application.setSensitivity(driveDoc!.frontmatter.id, "restricted", driveDoc!.contentHash);

    await dropDraft(root, "revised-summary.md", material({
      key: "sensitive-revised", meeting: workspace.meeting.frontmatter.id, sources: ["meet-transcript"], proposals: "proposals: []", summary: "Revised summary.\n",
      extra: `${occurrenceFields}\nsummary_evidence:\n  - source: drive-doc-1\n    locator: "page 2"`
    }));
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");

    const summaries = application.reviews().filter((review) => review.frontmatter.review_type === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.frontmatter).toMatchObject({ sensitivity: "restricted", proposed_fields: { summary: "Revised summary." } });
  });

  it("keeps a source's link to another meeting and lists it on this one instead", async () => {
    const { root, application } = await vault([event("evt-1"), event("evt-2")]);
    await dropDraft(root, "one.md", material({ key: "one", sources: ["gong-call"], proposals: "proposals: []" }));
    await application.adoptDrafts();
    await dropDraft(root, "two.md", material({ key: "two", meeting: "evt-2", sources: ["gong-call"], proposals: "proposals: []" }));
    await application.adoptDrafts();
    const sources = await ofType(application, "source");
    expect(sources).toHaveLength(1);
    const meetings = await ofType(application, "meeting");
    const second = meetings.find((meeting) => (meeting.frontmatter.external_refs as Array<{ external_id: string }>)[0]!.external_id === "evt-2")!;
    expect(sources[0]!.frontmatter.meeting_id).not.toBe(second.frontmatter.id);
    expect(second.frontmatter.source_ids).toEqual([sources[0]!.frontmatter.id]);
    expect(second.frontmatter.enrichment_missing_material).toEqual(["meet-transcript", "meet-recording", "gong-summary-email"]);
  });

  it("refuses restricted meetings without writing anything", async () => {
    const { root, application } = await vault();
    const { meeting } = await application.createMeetingFromEvent("evt-1", range.from, range.to, "work", "# Notes\n");
    await application.setSensitivity(meeting.frontmatter.id, "restricted", meeting.contentHash);
    await dropDraft(root, "material.md", material({ key: "r" }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("failed");
    expect(batch.drafts[0]!.reason).toMatch(/meeting: .*restricted/);
    expect(batch.drafts[0]!.reason).not.toContain("Q3 sync");
    expect(await ofType(application, "source")).toHaveLength(0);
    expect(application.reviews()).toHaveLength(0);
    expect((await application.object(meeting.frontmatter.id)).frontmatter.enrichment_state).toBeUndefined();
  });

  it("refuses a recurring draft when that occurrence's Note is restricted (#151, #175)", async () => {
    const occurrence = event("recurring-restricted", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([occurrence]);
    const workspace = await application.createMeetingFromEvent(occurrence.externalId, range.from, range.to, "work", "Private notes.\n");
    await application.setSensitivity(workspace.note!.frontmatter.id, "restricted", workspace.note!.contentHash);
    await dropDraft(root, "restricted-series.md", material({
      key: "restricted-series", meeting: workspace.meeting.frontmatter.id, sources: ["drive-doc"], proposals: "proposals: []", summary: "",
      extra: `recurrence_occurrence_id: google:work:weekly-series:${startedAt}`
    }));

    const result = (await application.adoptDrafts()).drafts[0]!;
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("is restricted") });
    expect(await ofType(application, "source")).toHaveLength(0);
    expect(application.reviews()).toHaveLength(0);
  });

  it("a restricted occurrence's Note keeps that Meeting's material and Review Items withheld, not the other occurrences' (#175, ADR 0018)", async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const first = event("series-first", { seriesId: "weekly-series", startsAt: hoursAgo(20), endsAt: hoursAgo(19), originalOccurrenceStartsAt: hoursAgo(20) });
    const second = event("series-second", { seriesId: "weekly-series", originalOccurrenceStartsAt: startedAt });
    const { root, application } = await vault([first, second]);
    const restrictedWorkspace = await application.createMeetingFromEvent(first.externalId, range.from, range.to, "work", "Private week\n");
    const openWorkspace = await application.createMeetingFromEvent(second.externalId, range.from, range.to, "work", "Open week\n");
    expect(openWorkspace.note!.frontmatter.id).not.toBe(restrictedWorkspace.note!.frontmatter.id);
    await application.setSensitivity(restrictedWorkspace.note!.frontmatter.id, "restricted", application.object(restrictedWorkspace.note!.frontmatter.id).contentHash);
    const restrictedId = restrictedWorkspace.meeting.frontmatter.id;
    const openId = openWorkspace.meeting.frontmatter.id;
    const taskDraft = (key: string, meeting: string) => `---\nlifeos_draft: 1\nkind: task\ndraft_key: ${key}\norigin: agent-extracted\nconfidence: High\ntitle: Task ${key}\ncaptured_at: 2026-10-04T09:15:00+02:00\nmeeting: ${meeting}\n---\n`;
    await dropDraft(root, "task-private.md", taskDraft("private", restrictedId));
    await dropDraft(root, "task-open.md", taskDraft("open", openId));
    await dropDraft(root, "material-private.md", material({ key: "material-private", meeting: restrictedId, sources: ["drive-doc"], proposals: "proposals: []" }));

    const results = (await application.adoptDrafts()).drafts;

    expect(results.filter((draft) => draft.outcome === "failed")).toMatchObject([{ draft: "_inbox/drafts/material-private.md", reason: expect.stringContaining("is restricted") }]);
    expect(results.filter((draft) => draft.outcome === "adopted")).toHaveLength(2);
    expect(await ofType(application, "source")).toHaveLength(0);
    const reviews = application.reviews();
    const reviewFor = (meetingId: string, reviewType: string) => reviews.filter((review) => review.frontmatter.source_meeting_id === meetingId && review.frontmatter.review_type === reviewType);
    expect(reviewFor(restrictedId, "create")).toHaveLength(1);
    expect(reviewFor(restrictedId, "create")[0]!.frontmatter.sensitivity).toBe("restricted");
    expect(reviewFor(openId, "create")).toHaveLength(1);
    expect(reviewFor(openId, "create")[0]!.frontmatter.sensitivity).toBeUndefined();
  });

  it("fails a malformed draft with path-aware reasons and writes nothing", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "bad.md", `---
lifeos_draft: 1
kind: meeting-material
draft_key: bad
origin: agent-extracted
title: Material
captured_at: 2026-10-04T09:15:00Z
meeting: evt-1
sources:
  - source_type: zoom-call
    url: https://example.test/x
    external_id: x
    occurred_at: ${startedAt}
  - source_type: meet-transcript
    occurred_at: yesterday
proposals:
  - kind: task
    title: Do it
    confidence: high
  - kind: knowledge-note
    title: Nope
    confidence: low
    missed_in_notes: true
    evidence: [{ source: x }]
summary_confidence: certain
---
`);
    const batch = await application.adoptDrafts();
    const reason = batch.drafts[0]!.reason!;
    expect(batch.drafts[0]!.outcome).toBe("failed");
    expect(reason).toContain("sources[0].source_type: unknown source type \"zoom-call\"");
    expect(reason).toContain("sources[1].url: missing");
    expect(reason).toContain("sources[1].external_id: missing");
    expect(reason).toContain("sources[1].occurred_at: not an ISO 8601");
    expect(reason).toContain("proposals[0].missed_in_notes: missing");
    expect(reason).toContain("proposals[0].evidence: missing");
    expect(reason).toContain("proposals[1].kind: ");
    expect(reason).toContain("summary_confidence: ");
    expect(await ofType(application, "meeting")).toHaveLength(0);
    expect(await ofType(application, "source")).toHaveLength(0);
    expect(application.reviews()).toHaveLength(0);
  });

  it("reports a proposal's own field problems under its index", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "bad.md", material({ key: "bad", proposals: proposalsYaml.replace("due_on: 2026-10-10", "due_on: tomorrow") }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.reason).toContain("proposals[0].due_on: not a calendar date");
    expect(await ofType(application, "source")).toHaveLength(0);
  });

  it("fails when the calendar event is unknown, and retries later when the calendar is unreachable", async () => {
    const { root, application, calendar } = await vault();
    await dropDraft(root, "unknown.md", material({ key: "u", meeting: "evt-nope" }));
    const failed = await application.adoptDrafts();
    expect(failed.drafts[0]).toMatchObject({ outcome: "failed" });
    expect(failed.drafts[0]!.reason).toContain("meeting: no LifeOS meeting or calendar event \"evt-nope\"");

    calendar.failure = new Error("network down");
    await dropDraft(root, "later.md", material({ key: "l" }));
    const skipped = await application.adoptDrafts();
    expect(skipped.drafts[0]).toMatchObject({ outcome: "skipped" });
    expect(await readdir(path.join(root, "_inbox", "drafts"))).toContain("later.md");
    calendar.failure = undefined;
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    expect(await ofType(application, "meeting")).toHaveLength(1);
  });
});
