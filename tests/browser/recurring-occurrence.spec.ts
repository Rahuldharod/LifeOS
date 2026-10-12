import { expect, test } from "@playwright/test";
import { RECURRING_NOTE, seed } from "./fixtures.js";

// #181: the Notes tab shows a recurring Note as one plain Note; the occurrence view lives in the Calendar.
test("a recurring Note opens as one plain Note in the Notes tab and keeps narrow navigation", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/notes/${RECURRING_NOTE.id}`);
  await expect(page.locator(".application-shell")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recurring meeting occurrences" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Show series" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete note" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole("button", { name: "Back to notes" })).toBeVisible();
  await expect(page.getByLabel("Notes list", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Back to notes" }).click();
  await expect(page.getByLabel("Notes list", { exact: true })).toBeVisible();
});

test("a new recurring occurrence shows the plain pending editor and its shared history as one read-only Series view block", async ({ page, request }) => {
  await seed(request);
  const stored = await (await request.get(`/api/v1/meetings/${RECURRING_NOTE.currentMeetingId}/workspace`)).json();
  const startsAt = "2026-10-19T08:00:00.000Z";
  const event = {
    externalId: "weekly-planning-next", calendarId: "mock-calendar", calendarName: "LifeOS Demo", title: "Weekly planning", startsAt, endsAt: "2026-10-19T08:30:00.000Z",
    timezone: "Europe/Paris", seriesId: "weekly-planning", originalOccurrenceStartsAt: startsAt, attendees: []
  };
  const meeting = { ...stored.meeting, body: "", relativePath: "", contentHash: "", frontmatter: { ...stored.meeting.frontmatter, id: `preview:${event.externalId}`, title: event.title, starts_at: startsAt, ends_at: event.endsAt, original_occurrence_starts_at: startsAt } };
  const range = { startsAt: "2026-10-05T08:00:00.000Z", endsAt: "2026-10-12T08:30:00.000Z" };
  await page.route("**/api/v1/calendar/day?*", (route) => route.fulfill({ json: { events: [event] } }));
  await page.route("**/api/v1/meetings/preview?*", (route) => route.fulfill({ json: {
    persisted: false, meeting, reviews: [], tasks: [], seriesView: { earlier: [{ kind: "legacy-shared", note: stored.note, range }] }, context: { people: [] }
  } }));

  await page.goto("/calendar/2026-10-19");
  await page.getByRole("button", { name: "Open event: Weekly planning" }).click();

  await expect(page.getByText("NEW OCCURRENCE")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recurring meeting occurrences" })).toHaveCount(0);
  await page.getByRole("button", { name: "Markdown" }).click();
  await expect(page.getByPlaceholder(/Capture meeting notes/)).toBeEditable();
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  await expect(series.locator("details")).toHaveCount(1);
  await expect(series.locator("summary")).toContainText("Shared Note");
  await expect(series.locator("summary")).toContainText("October 5, 2026 to Monday, October 12, 2026");
  await expect(series.locator("textarea")).toHaveCount(0);
});

// Incident 2026-10-12: after the first edit created the occurrence inside the shared Note, the browser kept only the
// typed text as its draft and the next autosave replaced every occurrence section with it.
test("the first edit on a new occurrence never shrinks the shared recurring Note", async ({ page, request }) => {
  await seed(request);
  const stored = await (await request.get(`/api/v1/meetings/${RECURRING_NOTE.currentMeetingId}/workspace`)).json();
  const startsAt = "2026-10-19T08:00:00.000Z";
  const sectionId = "occurrence-2026-10-19t08-00-00-000z";
  const event = { externalId: "weekly-planning-next", calendarId: "mock-calendar", calendarName: "LifeOS Demo", title: "Weekly planning", startsAt, endsAt: "2026-10-19T08:30:00.000Z", timezone: "Europe/Paris", seriesId: "weekly-planning", originalOccurrenceStartsAt: startsAt, attendees: [] };
  const meetingId = "77777777-7777-4777-8777-777777777777";
  const fields = { ...stored.meeting.frontmatter, title: event.title, starts_at: startsAt, ends_at: event.endsAt, recurrence_occurrence_id: `mock:mock-calendar:weekly-planning:${startsAt}`, original_occurrence_starts_at: startsAt };
  const preview = { ...stored.meeting, body: "", relativePath: "", contentHash: "", frontmatter: { ...fields, id: `preview:${event.externalId}` } };
  const pendingOccurrence = { sectionId, occurrenceId: fields.recurrence_occurrence_id, originalStartsAt: startsAt, meeting: preview, reviews: [], sources: [], context: { people: [] } };
  const legacyRange = { startsAt: "2026-10-05T08:00:00.000Z", endsAt: "2026-10-12T08:30:00.000Z" };
  const saved: string[] = [];
  await page.route("**/api/v1/calendar/day?*", (route) => route.fulfill({ json: { events: [event] } }));
  await page.route("**/api/v1/meetings/preview?*", (route) => route.fulfill({ json: { persisted: false, meeting: preview, reviews: [], tasks: [], seriesView: { earlier: [{ kind: "legacy-shared", note: stored.note, range: legacyRange }] }, context: { people: [] } } }));
  // The server wraps the first edit in a new section of the shared Note, as `createMeetingFromEvent` does.
  await page.route("**/api/v1/meetings/from-event", async (route) => {
    const { body } = route.request().postDataJSON() as { body: string };
    const meeting = { ...stored.meeting, frontmatter: { ...fields, id: meetingId } };
    const note = { ...stored.note, contentHash: "created-hash", body: `## Weekly planning — ${startsAt}\n<a id="${sectionId}"></a>\n\n${body}\n\n${stored.note.body}`, frontmatter: { ...stored.note.frontmatter, occurrence_sections: [{ section_id: sectionId, meeting_id: meetingId }, ...stored.note.frontmatter.occurrence_sections] } };
    const created = { persisted: true, meeting, note, reviews: [], tasks: [], occurrences: [{ ...pendingOccurrence, meeting }, ...stored.occurrences], context: { people: [] } };
    await page.route(`**/api/v1/meetings/${meetingId}/workspace`, (workspace) => workspace.fulfill({ json: created }));
    await route.fulfill({ json: created });
  });
  await page.route("**/api/v1/objects/*/body", async (route) => {
    const { body } = route.request().postDataJSON() as { body: string };
    saved.push(body);
    await route.fulfill({ json: { ...stored.note, body, contentHash: `saved-${saved.length}` } });
  });

  await page.goto("/calendar/2026-10-19");
  await page.getByRole("button", { name: "Open event: Weekly planning" }).click();
  // The real first-edit path: typing in the plain pending editor creates the occurrence, which the server merges into the shared Note.
  await page.getByRole("button", { name: "Markdown" }).click();
  await page.getByPlaceholder(/Capture meeting notes/).fill("This week");
  await page.waitForResponse("**/api/v1/meetings/from-event");
  const workspace = page.getByRole("region", { name: "Recurring meeting occurrences" });
  await expect(workspace.getByRole("textbox", { name: `Notes for ${sectionId}` })).toHaveValue("This week");
  // Longer than one autosave interval: the incident's destructive save landed 1.8 s after creation.
  await page.waitForTimeout(2500);
  await workspace.getByRole("textbox", { name: `Notes for ${sectionId}` }).pressSequentially("!");
  await expect.poll(() => saved.length, { timeout: 5000 }).toBeGreaterThan(0);

  for (const body of saved) {
    expect(body).toContain(`<a id="${RECURRING_NOTE.currentSectionId}"></a>`);
    expect(body).toContain(`<a id="${RECURRING_NOTE.olderSectionId}"></a>`);
  }
  expect(saved.at(-1)).toContain("This week!");
  const olderNotes = await workspace.locator(`textarea[aria-label="Notes for ${RECURRING_NOTE.olderSectionId}"]`).inputValue();
  expect(olderNotes).not.toBe("");
  expect(stored.note.body).toContain(olderNotes);

  // Typing at the end of a section keeps its spaces; only the separator between sections is app-managed.
  await workspace.getByRole("textbox", { name: `Notes for ${sectionId}` }).pressSequentially(" and more");
  await expect(workspace.getByRole("textbox", { name: `Notes for ${sectionId}` })).toHaveValue("This week! and more");
});
