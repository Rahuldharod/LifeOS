import { expect, test } from "@playwright/test";
import { BULK_PREFIX, seed } from "./fixtures.js";

// Inbox type tabs, single-key shortcuts and bulk Accept/Reject. Real local API, synthetic proposals from serve.mjs.
test("tabs group proposals; X ticks, bulk Accept and confirmed bulk Reject decide the ticked items", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  const queue = page.getByRole("region", { name: "Review queue" });
  const heading = page.getByRole("region", { name: "Review detail" }).getByRole("heading", { level: 2 });
  await page.getByLabel("Search proposals").fill(BULK_PREFIX);
  await page.keyboard.press("Escape"); // shortcuts are ignored while typing; Esc leaves the search box
  await expect(page.getByLabel("Search proposals")).not.toBeFocused();
  const rows = queue.getByRole("button", { name: /^Open proposal: Bulk proposal/ });
  await expect(rows).toHaveCount(3);

  // Tabs: 3 is the Decision tab; 1 goes back to All.
  await page.keyboard.press("3");
  await expect(page.getByRole("tab", { name: /^Decision/ })).toHaveAttribute("aria-selected", "true");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("1");
  await expect(rows).toHaveCount(3);

  // The shortcut hint is visible but stays out of the button's accessible name.
  await rows.first().click();
  await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveAttribute("aria-keyshortcuts", "R");

  // X ticks the open item; then tick a second row with its checkbox; bulk Accept decides both.
  const first = (await heading.textContent())!;
  await page.keyboard.press("x");
  await expect(page.getByLabel(`Select proposal: ${first}`)).toBeChecked();
  const second = (await rows.nth(1).getAttribute("aria-label"))!.replace("Open proposal: ", "");
  await page.getByLabel(`Select proposal: ${second}`).check();
  await page.getByRole("button", { name: "Accept selected (2)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 proposals accepted" })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(heading).not.toHaveText(first);

  // Bulk Reject does not ask first (ADR 0025: the toast's Undo replaces the confirmation).
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  page.on("dialog", () => { throw new Error("bulk Reject must not open a confirmation"); });
  await page.getByRole("button", { name: "Reject selected (1)" }).click();
  await expect(queue).toContainText("No matching proposals");
});
