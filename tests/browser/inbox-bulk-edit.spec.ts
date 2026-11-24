import { expect, test } from "@playwright/test";
import { BULK_EDIT_PREFIX, seed } from "./fixtures.js";

// PB-043 Inbox Bulk edit: field buttons for the fields the ticked proposals share; a picked value is set on all of them,
// they stay pending and ticked, and the toast's Undo puts the old values back. Real local API, synthetic proposals from serve.mjs.
test("Bulk edit sets a shared field on the ticked proposals, by mouse and by keyboard, and Undo puts it back", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  const queue = page.getByRole("region", { name: "Review queue" });
  await page.getByLabel("Search proposals").fill(BULK_EDIT_PREFIX);
  await page.keyboard.press("Escape");
  const rows = queue.locator(".inbox-row:not(.inbox-colhead)");
  await expect(rows).toHaveCount(3);
  const fields = page.getByRole("group", { name: "Set a field on the selected proposals" });
  const toast = page.locator(".inbox-toast");

  // Two Tasks and a Decision: only Project, Client and Product are common.
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(fields.getByRole("button")).toHaveText([/^Project: None/, /^Client: None/, /^Product: None/]);

  // Mouse: pick a project from the searchable list; all three get it, stay pending and stay ticked.
  await fields.getByRole("button", { name: /^Project/ }).click();
  await page.getByRole("combobox", { name: "Find project" }).fill("Harbor");
  await page.getByRole("listbox", { name: "Project" }).getByRole("option", { name: "Harbor onboarding" }).click();
  await expect(toast).toContainText("Project updated on 3 proposals");
  await expect(fields.getByRole("button", { name: /^Project/ })).toContainText("Harbor onboarding");
  await expect(rows).toHaveCount(3);
  await expect(queue.getByText("3 selected")).toBeVisible();
  for (const index of [0, 1, 2]) await expect(rows.nth(index)).toContainText("Harbor onboarding");

  // Undo (Z) puts every item back.
  await page.keyboard.press("z");
  await expect(toast).toContainText("Project put back on 3 proposals");
  await expect(fields.getByRole("button", { name: /^Project/ })).toContainText("None");

  // Only the Tasks ticked: Owner, Due and Priority join in, in the fixed order.
  const decision = (await rows.filter({ has: page.locator(".inbox-badge", { hasText: "Decision" }) }).locator(".inbox-row-open strong").textContent())!;
  await page.getByLabel(`Select proposal: ${decision}`).uncheck();
  await expect(fields.getByRole("button")).toHaveText([/^Owner: Me/, /^Due: No due date/, /^Priority: /, /^Project: None/, /^Client: None/, /^Product: None/]);

  // Keyboard: Enter opens Priority, ↓ moves, Enter applies; typing in a search box never reaches the Inbox keys; Esc closes.
  const priority = fields.getByRole("button", { name: /^Priority/ });
  await priority.focus();
  await page.keyboard.press("Enter");
  const list = page.getByRole("listbox", { name: "Priority" });
  await expect(list).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(toast).toContainText("Priority updated on 2 proposals");
  await expect(priority).toContainText("Medium");
  await expect(priority).toBeFocused();

  const owner = fields.getByRole("button", { name: /^Owner/ });
  await owner.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Find owner" })).toBeFocused();
  await page.keyboard.type("a");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "Find owner" })).toHaveCount(0);
  await expect(owner).toBeFocused();
  await expect(rows).toHaveCount(3); // "a" did not accept anything
  await expect(owner).toContainText("Me");
});
