import { expect, test } from "@playwright/test";
import { seed } from "./fixtures.js";

// Esc leaves the field being edited, anywhere in the app; a dialog still closes on its own Esc first.
// The Visual editor's slash menu closing on the first Esc is covered by escapeLeavesField.test.ts: placing the caret in
// a new empty paragraph is not deterministic in headless Chromium (arrow and "end" keys are sometimes ignored).
const solo = { meeting: "61000000-0000-4000-8000-000000000008", note: "62000000-0000-4000-8000-000000000008" };

test("Esc leaves the Visual note editor and keeps the typing", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-05-12/${solo.meeting}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo escape" })).toBeVisible();
  await editor.focus();
  await page.keyboard.type("Typed before Esc. ");
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeFocused();
  await expect.poll(async () => ((await (await request.get(`/api/v1/notes/${solo.note}`)).json()) as { body: string }).body, { timeout: 15000 }).toContain("Typed before Esc.");
});

test("Esc leaves a search box and keeps its text", async ({ page, request }) => {
  await seed(request);
  await page.goto("/tasks");
  const search = page.getByRole("searchbox").first();
  await search.fill("anything");
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue("anything");
});

test("Esc in Global Search closes the dialog first", async ({ page, request }) => {
  await seed(request);
  await page.goto("/tasks");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const dialog = page.getByRole("dialog", { name: "Global Search" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
