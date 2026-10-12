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
