import { expect, test, type APIRequestContext } from "@playwright/test";
import { seed } from "./fixtures.js";

// #173: earlier occurrences are edited in place. Real local API, no mocked saves (except the one deliberately
// blocked request in the draft-reload test). Uses the "retro" / "audit" series from serve.mjs: 3 occurrences each
// (Jan to Mar, one Note per occurrence) that only these tests change.
const ids = (letter: "e" | "f" | "7" | "8", month: string) => ({ meeting: `${letter}1000000-0000-4000-8000-0000000000${month}`, note: `${letter}2000000-0000-4000-8000-0000000000${month}` });
const RETRO = (month: string) => ids("e", month);
const AUDIT = (month: string) => ids("f", month);
const GUARD = (month: string) => ids("7", month);
const TYPING = (month: string) => ids("8", month);
const LEDGER = { own: "92000000-0000-4000-8000-000000000003", shared: "91000000-0000-4000-8000-000000000001" };

type Earlier = { note: { body: string; contentHash: string } };
const workspace = async (request: APIRequestContext, meetingId: string) => (await (await request.get(`/api/v1/meetings/${meetingId}/workspace`)).json()) as { note: { body: string }; seriesView: { earlier: Earlier[] } };

test("editing the opened and an earlier occurrence saves each to its own file; neither shrinks", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-10/${RETRO("03").meeting}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  const february = series.locator("details").nth(0);
  await february.locator("summary").click();
  await expect(february.locator("textarea")).toHaveValue(/retro words for 2026-02/);

  await february.locator("textarea").fill("retro words for 2026-02.\nFebruary follow-up.\n");
  await expect(february.getByRole("status")).toContainText("Saved to Markdown");
  await expect.poll(async () => (await workspace(request, RETRO("03").meeting)).seriesView.earlier[0]?.note.body).toBe("retro words for 2026-02.\nFebruary follow-up.\n");

  // The opened occurrence is not blocked while the other Note saved, and typing there keeps the caret.
  const march = page.locator("textarea:not(.series-note-editor textarea)").first();
  await march.click();
  await march.press("Control+End");
  await page.keyboard.type(" March follow-up.");
  await expect(march).toBeFocused();
  await expect.poll(async () => (await workspace(request, RETRO("03").meeting)).note.body).toContain("March follow-up.");

  const stored = await workspace(request, RETRO("03").meeting);
  expect(stored.note.body).toContain("retro words for 2026-03.");
  expect(stored.seriesView.earlier.map((entry) => entry.note.body)).toEqual(["retro words for 2026-02.\nFebruary follow-up.\n", "retro words for 2026-01.\n"]);
  await expect(series.getByRole("button", { name: /delete/i })).toHaveCount(0);
});

test("an unsaved draft in an earlier occurrence survives a reload", async ({ page, request }) => {
  await seed(request);
  const url = `/calendar/2026-03-10/${RETRO("03").meeting}`;
  await page.goto(url);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const january = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(1);
  await january.locator("summary").click();
  // Block the save so the text stays a browser draft only.
  await page.route("**/api/v1/objects/*/body", (route) => route.abort());
  await january.locator("textarea").fill("January draft that never reached the file.\n");
  await expect(january.getByRole("status")).toContainText("Cached locally");
  await page.unroute("**/api/v1/objects/*/body");
  await page.goto("about:blank");
  await page.goto(url);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const reopened = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(1);
  await reopened.locator("summary").click();
  await expect(reopened.locator("textarea")).toHaveValue("January draft that never reached the file.\n");
});

test("a conflict on one earlier Note pauses only that Note", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-10/${AUDIT("03").meeting}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  const february = series.locator("details").nth(0);
  const january = series.locator("details").nth(1);
  await february.locator("summary").click();
  await january.locator("summary").click();
  await expect(february.locator("textarea")).toHaveValue(/audit words for 2026-02/);

  // February changes on "another device" after the page loaded.
  const { seriesView } = await workspace(request, AUDIT("03").meeting);
  const put = await request.put(`/api/v1/objects/${AUDIT("02").note}/body`, { data: { body: "Changed elsewhere.\n", expectedHash: seriesView.earlier[0]!.note.contentHash } });
  expect(put.ok()).toBeTruthy();

  await february.locator("textarea").fill("My February draft.\n");
  await expect(february.getByRole("button", { name: /Keep browser version/i })).toBeVisible();
  // January still edits and saves independently.
  await january.locator("textarea").fill("audit words for 2026-01.\nJanuary edit.\n");
  await expect(january.getByRole("status")).toContainText("Saved to Markdown");
  expect((await workspace(request, AUDIT("03").meeting)).seriesView.earlier.map((entry) => entry.note.body)).toEqual(["Changed elsewhere.\n", "audit words for 2026-01.\nJanuary edit.\n"]);

  // "Keep current file" brings back the file's text for that Note, never an empty editor.
  await february.getByRole("button", { name: /Keep current file/i }).click();
  await expect(february.locator("textarea")).toHaveValue("Changed elsewhere.\n");
});

test("leaving the page within the autosave delay still writes an earlier occurrence to its file", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-10/${GUARD("03").meeting}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const february = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(0);
  await february.locator("summary").click();
  await february.locator("textarea").fill("guard words for 2026-02.\nTyped just before leaving.\n");
  // No wait: the 1.8 s autosave has not fired, so only the leave-page save can put this in the file.
  await page.locator("nav[aria-label='Primary']").getByRole("button", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/\/tasks/);
  const stored = await workspace(request, GUARD("03").meeting);
  expect(stored.seriesView.earlier[0]!.note.body).toBe("guard words for 2026-02.\nTyped just before leaving.\n");
});

test("a restricted earlier Note shows the Restricted marker and an unrestricted one does not", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-10/${GUARD("03").meeting}`);
  const entries = page.getByRole("region", { name: "Earlier occurrences" }).locator("details");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0).locator("summary")).not.toContainText("Restricted"); // February
  await expect(entries.nth(1).locator("summary")).toContainText("Restricted"); // January, restricted in serve.mjs
});

test("typing keeps landing in the same editor, in order, while another Note's autosave is in flight", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-10/${TYPING("03").meeting}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  const february = series.locator("details").nth(0);
  const january = series.locator("details").nth(1);
  await february.locator("summary").click();
  await january.locator("summary").click();
  // Hold January's save in flight for 2 s so it completes while the user is still typing in February.
  await page.route(`**/api/v1/objects/${TYPING("01").note}/body`, async (route) => { await new Promise((resolve) => setTimeout(resolve, 2000)); await route.continue(); });
  await january.locator("textarea").fill("typing words for 2026-01.\nJanuary edit.\n");
  const text = "0123456789".repeat(14);
  await february.locator("textarea").click();
  await february.locator("textarea").press("Control+End");
  await page.keyboard.type(text, { delay: 45 });
  await expect(february.locator("textarea")).toBeFocused();
  await expect(february.locator("textarea")).toHaveValue(`typing words for 2026-02.\n${text}`);
  await expect(january.getByRole("status")).toContainText("Saved to Markdown");
  await expect(february.getByRole("status")).toContainText("Saved to Markdown");
  expect((await workspace(request, TYPING("03").meeting)).seriesView.earlier.map((entry) => entry.note.body)).toEqual([`typing words for 2026-02.\n${text}`, "typing words for 2026-01.\nJanuary edit.\n"]);
});

test("in the Visual editor, typing also stays in one editor while another Note's autosave completes", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-10/${TYPING("03").meeting}`);
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  const february = series.locator("details").nth(0);
  const january = series.locator("details").nth(1);
  await february.locator("summary").click();
  await january.locator("summary").click();
  const visual = (entry: typeof february) => entry.locator("[contenteditable='true']").first();
  await expect(visual(january)).toBeVisible();
  await page.route(`**/api/v1/objects/${TYPING("01").note}/body`, async (route) => { await new Promise((resolve) => setTimeout(resolve, 2000)); await route.continue(); });
  await visual(january).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" visual January.");
  await visual(february).click();
  await page.keyboard.press("Control+End");
  const text = "abcdefghij".repeat(10);
  await page.keyboard.type(text, { delay: 45 });
  await expect(visual(february)).toBeFocused();
  await expect(visual(february)).toContainText(text);
  await expect(january.getByRole("status")).toContainText("Saved to Markdown");
  await expect(february.getByRole("status")).toContainText("Saved to Markdown");
  // The status reads "Saved" before the first keystroke is dirty, so wait on the files themselves.
  await expect.poll(async () => (await workspace(request, TYPING("03").meeting)).seriesView.earlier.map((entry) => entry.note.body.includes(text) ? "february typed" : entry.note.body.includes("visual January.") ? "january typed" : "missing"), { timeout: 15000 }).toEqual(["february typed", "january typed"]);
});

test("a Legacy shared Note block is edited through the UI and saved as one whole body, sections kept", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-04-20/${LEDGER.own}`);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const shared = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(0);
  await expect(shared.locator("summary")).toContainText("Shared Note");
  await shared.locator("summary").click();
  await shared.locator("textarea").fill("Ledger shared words.\n\n## Added\nWhole-body edit.\n");
  await expect(shared.getByRole("status")).toContainText("Saved to Markdown");
  const stored = (await workspace(request, LEDGER.own)).seriesView.earlier[0] as unknown as { note: { body: string; frontmatter: { occurrence_sections: unknown[] } } };
  expect(stored.note.body).toBe("Ledger shared words.\n\n## Added\nWhole-body edit.\n");
  expect(stored.note.frontmatter.occurrence_sections).toHaveLength(2);
});
