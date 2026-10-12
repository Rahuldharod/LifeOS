// #154: starts the real LifeOS server for browser tests on port 4319, over a fresh temporary synthetic data root.
// Serves the built web app (apps/web/dist). Never touches the real data root, .dev-data/ or ports 4310/4311/5174.
import { spawn } from "node:child_process";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = path.join(repo, "apps/web/dist");
const index = await stat(path.join(webRoot, "index.html")).catch(() => undefined);
if (!index) {
  console.error("apps/web/dist/index.html is missing: run `pnpm --filter @lifeos/web build` first.");
  process.exit(1);
}

const dataRoot = await mkdtemp(path.join(tmpdir(), "lifeos-browser-data-"));
const backupRoot = await mkdtemp(path.join(tmpdir(), "lifeos-browser-backups-"));
await mkdir(path.join(dataRoot, ".lifeos"), { recursive: true });
await writeFile(path.join(dataRoot, ".lifeos/schema.md"), "# LifeOS data root\n\nSynthetic browser-test data (#154).\n");
await mkdir(path.join(dataRoot, "people"), { recursive: true });
await cp(path.join(repo, "schemas/fixtures/person-self.md"), path.join(dataRoot, "people/person-self.md"));

// A complete recurring-note workspace for #149's real-browser contract: two editable occurrence sections,
// immutable event snapshots, one linked material, an accepted summary and one pending proposal.
const objectFile = async (folder, name, frontmatter, body = "") => {
  const target = path.join(dataRoot, folder, `${name}.md`);
  await mkdir(path.dirname(target), { recursive: true });
  const yaml = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(target, `---\n${yaml}\n---\n${body}`);
};
const stamped = (id, type, title) => ({ id, type, schema_version: 1, revision: 1, title, created_at: "2026-10-05T08:00:00.000Z", updated_at: "2026-10-12T08:30:00.000Z", updated_by_device: "browser-test", origin: "app" });
const recurring = {
  olderMeeting: "11111111-1111-4111-8111-111111111111",
  currentMeeting: "22222222-2222-4222-8222-222222222222",
  note: "33333333-3333-4333-8333-333333333333",
  source: "44444444-4444-4444-8444-444444444444",
  review: "55555555-5555-4555-8555-555555555555",
  operation: "66666666-6666-4666-8666-666666666666",
  series: "mock:mock-calendar:weekly-planning",
  olderSection: "occurrence-2026-10-05t08-00-00-000z",
  currentSection: "occurrence-2026-10-12t08-00-00-000z"
};
await objectFile("meetings", recurring.olderMeeting, {
  ...stamped(recurring.olderMeeting, "meeting", "Weekly planning"), status: "scheduled", starts_at: "2026-10-05T08:00:00.000Z", ends_at: "2026-10-05T08:30:00.000Z", timezone: "Europe/Paris", attendee_ids: [], location: "Example room", recurrence_series_id: recurring.series, recurrence_occurrence_id: `${recurring.series}:2026-10-05T08:00:00.000Z`, original_occurrence_starts_at: "2026-10-05T08:00:00.000Z"
}, "# Weekly planning\n");
await objectFile("meetings", recurring.currentMeeting, {
  ...stamped(recurring.currentMeeting, "meeting", "Weekly planning"), status: "scheduled", starts_at: "2026-10-12T08:00:00.000Z", ends_at: "2026-10-12T08:30:00.000Z", timezone: "Europe/Paris", attendee_ids: [], location: "Example room", join_url: "https://meet.example.com/weekly-planning", source_ids: [recurring.source], recurrence_series_id: recurring.series, recurrence_occurrence_id: `${recurring.series}:2026-10-12T08:00:00.000Z`, original_occurrence_starts_at: "2026-10-12T08:00:00.000Z"
}, "<!-- lifeos:summary:start -->\n## Summary\nAgreed the synthetic launch plan.\n<!-- lifeos:summary:end -->\n");
await objectFile("meetings", recurring.note, {
  ...stamped(recurring.note, "meeting-note", "Weekly planning notes"), meeting_id: recurring.currentMeeting, meeting_ids: [recurring.currentMeeting, recurring.olderMeeting], recurrence_series_id: recurring.series, generated_title: "Weekly planning notes", occurrence_sections: [
    { occurrence_id: `${recurring.series}:2026-10-12T08:00:00.000Z`, section_id: recurring.currentSection, meeting_id: recurring.currentMeeting, original_starts_at: "2026-10-12T08:00:00.000Z", starts_at: "2026-10-12T08:00:00.000Z" },
    { occurrence_id: `${recurring.series}:2026-10-05T08:00:00.000Z`, section_id: recurring.olderSection, meeting_id: recurring.olderMeeting, original_starts_at: "2026-10-05T08:00:00.000Z", starts_at: "2026-10-05T08:00:00.000Z" }
  ]
}, `## Weekly planning — 2026-10-12T08:00:00.000Z\n<a id="${recurring.currentSection}"></a>\n\nCurrent occurrence notes.\n\n## Weekly planning — 2026-10-05T08:00:00.000Z\n<a id="${recurring.olderSection}"></a>\n\nOlder occurrence notes.\n`);
await objectFile("sources", recurring.source, {
  ...stamped(recurring.source, "source", "Synthetic planning transcript"), source_type: "meet-transcript", captured_at: "2026-10-12T08:35:00.000Z", ingestion_status: "processed", meeting_id: recurring.currentMeeting, url: "https://drive.example.com/docs/weekly-planning", retrieved_at: "2026-10-12T08:35:00.000Z"
}, "Synthetic transcript content.\n");
// #179 Series view: six monthly occurrences of one provider series, each with its own Note except
// June, which has none and must be skipped. Opening September shows the 4 Notes before it.
const monthly = { series: "mock:mock-calendar:monthly-review", months: ["04", "05", "06", "07", "08", "09"] };
for (const [index, month] of monthly.months.entries()) {
  const meetingId = `a1000000-0000-4000-8000-00000000000${index + 1}`;
  const startsAt = `2026-${month}-07T08:00:00.000Z`;
  await objectFile("meetings", meetingId, {
    ...stamped(meetingId, "meeting", "Monthly review"), status: "scheduled", starts_at: startsAt, ends_at: `2026-${month}-07T09:00:00.000Z`, timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: monthly.series, recurrence_occurrence_id: `${monthly.series}:${startsAt}`, original_occurrence_starts_at: startsAt
  });
  if (month === "06") continue;
  const noteId = `b1000000-0000-4000-8000-00000000000${index + 1}`;
  await objectFile("meetings", noteId, { ...stamped(noteId, "meeting-note", `Monthly review notes ${month}`), meeting_id: meetingId }, `Monthly review words for 2026-${month}.\n`);
}
// #180 paging: eight weekly occurrences of one series, each with a Note; the 6th was cancelled (its Note is kept),
// and a 9th was cancelled without a Note (hidden). Opening the 8th shows 4 earlier, then "Load older" adds the other 3.
const weekly = { series: "mock:mock-calendar:weekly-sync", firstDay: 2 };
for (let index = 1; index <= 9; index += 1) {
  const meetingId = `e1000000-0000-4000-8000-00000000000${index}`;
  const day = String(weekly.firstDay + (index - 1) * 7).padStart(2, "0");
  const month = weekly.firstDay + (index - 1) * 7 > 31 ? "04" : "03";
  const date = month === "04" ? `2026-04-${String(weekly.firstDay + (index - 1) * 7 - 31).padStart(2, "0")}` : `2026-03-${day}`;
  const startsAt = `${date}T08:00:00.000Z`;
  await objectFile("meetings", meetingId, {
    ...stamped(meetingId, "meeting", "Weekly sync"), status: index === 6 || index === 9 ? "cancelled" : "scheduled", starts_at: startsAt, ends_at: `${date}T09:00:00.000Z`, timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: weekly.series, recurrence_occurrence_id: `${weekly.series}:${startsAt}`, original_occurrence_starts_at: startsAt
  });
  if (index === 9) continue;
  const noteId = `e2000000-0000-4000-8000-00000000000${index}`;
  await objectFile("meetings", noteId, { ...stamped(noteId, "meeting-note", `Weekly sync notes ${index}`), meeting_id: meetingId }, `Weekly sync words ${index}.\n`);
}
// #179: a Legacy shared Note (one Note, two Meetings of the "weekly-prio" series) plus a later occurrence with its own Note.
const prio = { series: "mock:mock-calendar:weekly-prio", note: "d1000000-0000-4000-8000-000000000001", own: "d1000000-0000-4000-8000-000000000002", ownNote: "d1000000-0000-4000-8000-000000000003", meetings: ["c1000000-0000-4000-8000-000000000001", "c1000000-0000-4000-8000-000000000002"], days: ["2026-09-07", "2026-09-14"] };
for (const [index, meetingId] of prio.meetings.entries()) {
  const startsAt = `${prio.days[index]}T08:00:00.000Z`;
  await objectFile("meetings", meetingId, {
    ...stamped(meetingId, "meeting", "Weekly Prio"), status: "scheduled", starts_at: startsAt, ends_at: `${prio.days[index]}T09:00:00.000Z`, timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: prio.series, recurrence_occurrence_id: `${prio.series}:${startsAt}`, original_occurrence_starts_at: startsAt
  });
}
await objectFile("meetings", prio.note, {
  ...stamped(prio.note, "meeting-note", "Weekly Prio notes"), meeting_id: prio.meetings[0], meeting_ids: prio.meetings, recurrence_series_id: prio.series,
  occurrence_sections: prio.meetings.map((meetingId, index) => ({ occurrence_id: `${prio.series}:${prio.days[index]}T08:00:00.000Z`, section_id: `occurrence-${prio.days[index]}`, meeting_id: meetingId, original_starts_at: `${prio.days[index]}T08:00:00.000Z`, starts_at: `${prio.days[index]}T08:00:00.000Z` }))
}, "Legacy shared Prio words.\n");
await objectFile("meetings", prio.own, {
  ...stamped(prio.own, "meeting", "Weekly Prio"), status: "scheduled", starts_at: "2026-09-21T08:00:00.000Z", ends_at: "2026-09-21T09:00:00.000Z", timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: prio.series, recurrence_occurrence_id: `${prio.series}:2026-09-21T08:00:00.000Z`, original_occurrence_starts_at: "2026-09-21T08:00:00.000Z"
});
await objectFile("meetings", prio.ownNote, { ...stamped(prio.ownNote, "meeting-note", "Weekly Prio notes 21 Sep"), meeting_id: prio.own }, "Own occurrence words.\n");
// #173 edit-in-place: two small series (3 occurrences each, a Note per occurrence) that only the edit tests change,
// so the read-only #179 tests above keep their text. "retro" is edited; "audit" is used for the conflict test.
// "guard" tests the leave-page save, "typing" the caret while another Note saves, "ledger" a Legacy shared Note (below).
for (const [letter, name] of [["5", "retro"], ["f", "audit"], ["7", "guard"], ["8", "typing"]]) {
  const series = `mock:mock-calendar:${name}`;
  for (const month of ["01", "02", "03"]) {
    const meetingId = `${letter}1000000-0000-4000-8000-0000000000${month}`;
    const noteId = `${letter}2000000-0000-4000-8000-0000000000${month}`;
    const startsAt = `2026-${month}-10T08:00:00.000Z`;
    await objectFile("meetings", meetingId, { ...stamped(meetingId, "meeting", `Team ${name}`), status: "scheduled", starts_at: startsAt, ends_at: `2026-${month}-10T09:00:00.000Z`, timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: series, recurrence_occurrence_id: `${series}:${startsAt}`, original_occurrence_starts_at: startsAt });
    await objectFile("meetings", noteId, { ...stamped(noteId, "meeting-note", `Team ${name} notes ${month}`), meeting_id: meetingId, ...(name === "guard" && month === "01" ? { sensitivity: "restricted" } : {}) },`${name} words for 2026-${month}.\n`);
  }
}
// "ledger": a Legacy shared Note covering two Meetings plus a later occurrence with its own Note (the edit test opens the later one).
const ledger = { series: "mock:mock-calendar:ledger", note: "91000000-0000-4000-8000-000000000001", meetings: ["92000000-0000-4000-8000-000000000001", "92000000-0000-4000-8000-000000000002"], days: ["2026-04-06", "2026-04-13"], own: "92000000-0000-4000-8000-000000000003", ownNote: "91000000-0000-4000-8000-000000000003" };
for (const [index, meetingId] of ledger.meetings.entries()) {
  const startsAt = `${ledger.days[index]}T08:00:00.000Z`;
  await objectFile("meetings", meetingId, { ...stamped(meetingId, "meeting", "Team ledger"), status: "scheduled", starts_at: startsAt, ends_at: `${ledger.days[index]}T09:00:00.000Z`, timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: ledger.series, recurrence_occurrence_id: `${ledger.series}:${startsAt}`, original_occurrence_starts_at: startsAt });
}
await objectFile("meetings", ledger.note, {
  ...stamped(ledger.note, "meeting-note", "Team ledger notes"), meeting_id: ledger.meetings[0], meeting_ids: ledger.meetings, recurrence_series_id: ledger.series,
  occurrence_sections: ledger.meetings.map((meetingId, index) => ({ occurrence_id: `${ledger.series}:${ledger.days[index]}T08:00:00.000Z`, section_id: `occurrence-${ledger.days[index]}`, meeting_id: meetingId, original_starts_at: `${ledger.days[index]}T08:00:00.000Z`, starts_at: `${ledger.days[index]}T08:00:00.000Z` }))
}, "Ledger shared words.\n");
await objectFile("meetings", ledger.own, { ...stamped(ledger.own, "meeting", "Team ledger"), status: "scheduled", starts_at: "2026-04-20T08:00:00.000Z", ends_at: "2026-04-20T09:00:00.000Z", timezone: "Europe/Paris", attendee_ids: [], recurrence_series_id: ledger.series, recurrence_occurrence_id: `${ledger.series}:2026-04-20T08:00:00.000Z`, original_occurrence_starts_at: "2026-04-20T08:00:00.000Z" });
await objectFile("meetings", ledger.ownNote, { ...stamped(ledger.ownNote, "meeting-note", "Team ledger notes 20 Apr"), meeting_id: ledger.own }, "Ledger own words.\n");
await objectFile("review-items", recurring.review, {
  ...stamped(recurring.review, "review-item", "Send the synthetic agenda"), review_type: "create", target_object_type: "task", proposed_fields: { title: "Send the synthetic agenda", source_meeting_id: recurring.currentMeeting }, confidence_label: "High", status: "pending", operation_id: recurring.operation, source_meeting_id: recurring.currentMeeting, occurrence_section_id: recurring.currentSection
}, "Synthetic proposal.\n");

// Inbox Drafts (skills/lifeos-object-contract): the server adopts them once they are 2 seconds old, so they are
// written here (the API has no route that creates them) and backdated. `seed()` in fixtures.ts triggers adoption.
const drafts = path.join(dataRoot, "_inbox/drafts");
await mkdir(drafts, { recursive: true });
const longBody = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. Synthetic research notes about portable Markdown, offline-first storage and review workflows. `.repeat(6).trim()).join("\n\n");
const files = {};
const draft = (name, front, body) => { files[`${name}.md`] = `---\nlifeos_draft: 1\n${Object.entries({ ...front, captured_at: "2026-10-01T09:00:00Z" }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}\n`; };
for (let i = 1; i <= 12; i += 1) {
  draft(`knowledge-${String(i).padStart(2, "0")}`, { kind: "knowledge-note", draft_key: `browser-knowledge-${i}`, origin: "user-dictated", title: `Browser knowledge note ${i}` }, i === 1 ? longBody : `Synthetic knowledge body ${i} for example.com testing.\n\nSecond paragraph ${i}.`);
}
draft("review-task-1", { kind: "task", draft_key: "browser-review-task-1", origin: "agent-extracted", confidence: "High", title: "Browser review: send the example.com agenda" }, "Extracted from a synthetic email.");
draft("review-task-2", { kind: "task", draft_key: "browser-review-task-2", origin: "agent-extracted", confidence: "Medium", title: "Browser review: confirm the pilot date" }, "Extracted from a synthetic transcript.");
draft("review-decision-1", { kind: "decision", draft_key: "browser-review-decision-1", origin: "agent-extracted", confidence: "Medium", title: "Browser review: adopt weekly reviews" }, "Extracted from a synthetic meeting.");
for (const [name, content] of Object.entries(files)) {
  const file = path.join(drafts, name);
  await writeFile(file, content);
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
}

// #172: recurring occurrences the mock calendar reports, so real-API browser tests can open a NEW occurrence of a seeded series.
// "weekly-prio" has a Legacy shared Note plus a later per-occurrence Note; "monthly-review" has only per-occurrence Notes.
const mockEvents = path.join(backupRoot, "mock-events.json");
const mockEvent = (externalId, title, seriesId, day) => ({ externalId, calendarId: "mock-calendar", calendarName: "LifeOS Demo", title, startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T09:00:00.000Z`, timezone: "Europe/Paris", attendees: [], seriesId, originalOccurrenceStartsAt: `${day}T08:00:00.000Z` });
await writeFile(mockEvents, JSON.stringify([
  mockEvent("mock-weekly-prio-next", "Weekly Prio", "weekly-prio", "2026-09-28"),
  mockEvent("mock-monthly-review-next", "Monthly review", "monthly-review", "2026-10-07")
]));

const server = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  cwd: path.join(repo, "apps/server"),
  stdio: "inherit",
  env: {
    ...process.env,
    LIFEOS_PORT: "4319",
    LIFEOS_HOST: "127.0.0.1",
    LIFEOS_DATA_ROOT: dataRoot,
    LIFEOS_BACKUP_ROOT: backupRoot,
    LIFEOS_DEVICE_ID: "browser-test",
    LIFEOS_CALENDAR: "mock",
    LIFEOS_MOCK_EVENTS: mockEvents,
    LIFEOS_WEB_ROOT: webRoot
  }
});

/** Backup snapshots are read-only. */
function makeWritable(root) {
  try { chmodSync(root, 0o755); } catch { return; }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(full);
    else try { chmodSync(full, 0o644); } catch { /* already gone */ }
  }
}
// Synchronous so it also finishes when the runner follows its SIGTERM with a SIGKILL.
function cleanup() {
  for (const root of [dataRoot, backupRoot]) { makeWritable(root); try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { console.error(`Could not remove ${root}: ${error.message}`); } }
}
// Let the server finish its own shutdown (it may still be writing) before removing its folders; never wait forever.
const stop = (signal) => {
  if (server.exitCode !== null) { cleanup(); process.exit(0); }
  server.kill(signal);
  setTimeout(() => { cleanup(); process.exit(0); }, 5_000).unref();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGTERM"));
process.on("exit", cleanup);
server.on("exit", (code) => { cleanup(); process.exit(code ?? 1); });
