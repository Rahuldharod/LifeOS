import { expect, test } from "@playwright/test";
import { RECURRING_NOTE, seed } from "./fixtures.js";

test("a recurring Note keeps occurrence context through history editing and narrow navigation", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/notes/${RECURRING_NOTE.id}#${RECURRING_NOTE.currentSectionId}`);
  await expect(page.locator(".application-shell")).toBeVisible();

  const workspace = page.getByRole("region", { name: "Recurring meeting occurrences" });
  const current = workspace.locator("details").filter({ has: page.getByText("Monday, October 12, 2026") });
  await expect(current).toHaveAttribute("open", "");
  await expect(current).toHaveClass(/selected/);
  await expect(current.locator("[aria-label='Saved event snapshot']")).toContainText("Weekly planning");
  await expect(current.getByRole("heading", { name: "Materials" }).locator("..")).toContainText("Synthetic planning transcript");
  await expect(current.getByRole("heading", { name: "Accepted summary" }).locator("..")).toContainText("Agreed the synthetic launch plan");
  await expect(current.getByRole("textbox", { name: "Proposed title" })).toHaveValue(
    "Send the synthetic agenda",
  );

  const older = workspace.locator("details").filter({ has: page.getByText("Monday, October 5, 2026") });
  await expect(older).not.toHaveAttribute("open", "");
  await older.locator("summary").click();
  await expect(page).toHaveURL(new RegExp(`#${RECURRING_NOTE.olderSectionId}$`));
  const notes = older.getByRole("textbox", { name: `Notes for ${RECURRING_NOTE.olderSectionId}` });
  await notes.fill("Historical note edited in the browser.");
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.locator(".save-state")).toContainText("Saved to Markdown");
  await expect(page).toHaveURL(new RegExp(`#${RECURRING_NOTE.olderSectionId}$`));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#${RECURRING_NOTE.olderSectionId}$`));
  await expect(page.getByRole("textbox", { name: `Notes for ${RECURRING_NOTE.olderSectionId}` })).toHaveValue("Historical note edited in the browser.");

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole("button", { name: "Back to notes" })).toBeVisible();
  await expect(page.getByLabel("Notes list", { exact: true })).toBeHidden();
  await expect(page.locator("details.selected")).toContainText("Monday, October 5, 2026");
  await page.getByRole("button", { name: "Back to notes" }).click();
  await expect(page.getByLabel("Notes list", { exact: true })).toBeVisible();
});

test("a new recurring occurrence previews shared history before its first edit", async ({ page, request }) => {
  await seed(request);
  const storedResponse = await request.get(`/api/v1/meetings/${RECURRING_NOTE.currentMeetingId}/workspace`);
  expect(storedResponse.ok()).toBe(true);
  const stored = await storedResponse.json();
  const startsAt = "2026-10-19T08:00:00.000Z";
  const sectionId = "occurrence-2026-10-19t08-00-00-000z";
  const event = {
    externalId: "weekly-planning-next",
    calendarId: "mock-calendar",
    calendarName: "LifeOS Demo",
    title: "Weekly planning",
    startsAt,
    endsAt: "2026-10-19T08:30:00.000Z",
    timezone: "Europe/Paris",
    seriesId: "weekly-planning",
    originalOccurrenceStartsAt: startsAt,
    attendees: []
  };
  const meeting = {
    ...stored.meeting,
    body: "",
    relativePath: "",
    contentHash: "",
    frontmatter: {
      ...stored.meeting.frontmatter,
      id: `preview:${event.externalId}`,
      title: event.title,
      starts_at: event.startsAt,
      ends_at: event.endsAt,
      recurrence_occurrence_id: `mock:mock-calendar:${event.seriesId}:${startsAt}`,
      original_occurrence_starts_at: startsAt
    }
  };
  const pendingOccurrence = {
    sectionId,
    occurrenceId: `mock:mock-calendar:${event.seriesId}:${startsAt}`,
    originalStartsAt: startsAt,
    meeting,
    reviews: [],
    sources: [],
    context: { people: [] }
  };
  await page.route("**/api/v1/calendar/day?*", (route) => route.fulfill({ json: { events: [event] } }));
  await page.route("**/api/v1/meetings/preview?*", (route) => route.fulfill({ json: {
    persisted: false,
    meeting,
    reviews: [],
    tasks: [],
    seriesNotePreview: stored.note,
    occurrences: stored.occurrences,
    pendingOccurrence,
    context: { people: [] }
  } }));

  await page.goto("/calendar/2026-10-19");
  await page.getByRole("button", { name: "Open event: Weekly planning" }).click();

  await expect(page.getByText("NEW OCCURRENCE")).toBeVisible();
  const workspace = page.getByRole("region", { name: "Recurring meeting occurrences" });
  await expect(workspace).toContainText("Current occurrence notes.");
  await expect(workspace).toContainText("Not saved yet");
  await expect(workspace.getByRole("textbox", { name: `Notes for ${sectionId}` })).toBeEditable();
  await expect(workspace.locator(`textarea[aria-label="Notes for ${RECURRING_NOTE.olderSectionId}"]`)).toBeDisabled();
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
  const saved: string[] = [];
  await page.route("**/api/v1/calendar/day?*", (route) => route.fulfill({ json: { events: [event] } }));
  await page.route("**/api/v1/meetings/preview?*", (route) => route.fulfill({ json: { persisted: false, meeting: preview, reviews: [], tasks: [], seriesNotePreview: stored.note, occurrences: stored.occurrences, pendingOccurrence, context: { people: [] } } }));
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
  const workspace = page.getByRole("region", { name: "Recurring meeting occurrences" });
  await workspace.getByRole("textbox", { name: `Notes for ${sectionId}` }).fill("This week");
  await page.waitForResponse("**/api/v1/meetings/from-event");
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
