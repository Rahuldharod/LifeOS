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

test("a new recurring occurrence shows the plain pending editor and its shared history as one Series view block", async ({ page, request }) => {
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
  await series.locator("summary").click();
  await expect(series.locator("textarea")).toBeEditable(); // #173: the earlier Note is edited in place
});

// Incident 2026-10-12: after the first edit created the occurrence inside the shared Note, the browser kept only the
// typed text as its draft and the next autosave replaced every occurrence section with it.
// #172: the first edit now creates only this occurrence's own Meeting and Note. This test runs against the real local API
// (nothing about creation or saving is mocked): the seeded "weekly-prio" series has a Legacy shared Note and an earlier
// per-occurrence Note, and the mock calendar reports a new 28 September occurrence of it (see serve.mjs).
test("the first edit on a new occurrence creates only its own Note and no save ever touches another occurrence's Note", async ({ page, request }) => {
  await seed(request);
  type NoteRow = { frontmatter: { id: string }; body: string; contentHash: string };
  const readNotes = async () => new Map(((await (await request.get("/api/v1/notes")).json()) as NoteRow[]).map((note) => [note.frontmatter.id, note] as const));
  const before = await readNotes();
  const legacyId = "d1000000-0000-4000-8000-000000000001";
  expect(before.get(legacyId)?.body).toBe("Legacy shared Prio words.\n");

  await page.goto("/calendar/2026-09-28");
  await page.getByRole("button", { name: "Open event: Weekly Prio" }).click();
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  await expect(series.locator("details")).toHaveCount(2);

  await page.getByRole("button", { name: "Markdown" }).click();
  const editor = page.getByPlaceholder(/Capture meeting notes/);
  await editor.fill("This week");
  await page.waitForResponse("**/api/v1/meetings/from-event");
  // Longer than one autosave interval: the incident's destructive save landed 1.8 s after creation.
  await page.waitForTimeout(2500);
  await editor.pressSequentially("!");
  await expect.poll(async () => [...(await readNotes()).values()].filter((note) => !before.has(note.frontmatter.id)).map((note) => note.body), { timeout: 8000 }).toEqual(["This week!"]);
  await page.waitForTimeout(2500);

  const after = await readNotes();
  // Exactly one new Note; every Note that existed before is byte-identical (same hash, same body).
  expect([...after.keys()].filter((id) => !before.has(id))).toHaveLength(1);
  for (const [id, note] of before) {
    expect(after.get(id)?.contentHash, `Note ${id} must not change`).toBe(note.contentHash);
    expect(after.get(id)?.body).toBe(note.body);
  }
  // The Series view still shows the earlier occurrences after creation.
  await expect(page.getByRole("region", { name: "Earlier occurrences" }).locator("details")).toHaveCount(2);
  const summaries = page.getByRole("region", { name: "Earlier occurrences" }).locator("summary");
  await expect(summaries.nth(0)).toContainText("September 21, 2026");
  await expect(summaries.nth(1)).toContainText("Shared Note");
});
