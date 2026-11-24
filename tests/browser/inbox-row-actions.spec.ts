import { expect, test } from "@playwright/test";
import { ROW_ACTION_PREFIX, seed } from "./fixtures.js";

// #239: row buttons (own column, shown on hover / Focused / Open) and group buttons. Real local API, synthetic proposals from serve.mjs.
test("row buttons stay in their own column, act on the row and move focus on; group Accept all acts on the group", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  await page.getByLabel("Search proposals").fill(ROW_ACTION_PREFIX);
  await page.keyboard.press("Escape");
  const queue = page.getByRole("region", { name: "Review queue" });
  const rows = queue.locator(".inbox-row:not(.inbox-colhead)");
  await expect(rows).toHaveCount(4);
  const heading = page.getByRole("region", { name: "Review detail" }).getByRole("heading", { level: 2 });
  const toast = (text: string) => page.locator(".inbox-toast").filter({ hasText: text });
  const actions = (index: number) => rows.nth(index).locator(".c-actions");
  const titleOf = async (index: number) => (await rows.nth(index).locator(".inbox-row-open strong").textContent())!;

  // Hidden until the row is hovered, Focused or Open; the Open item (first row) shows them.
  await rows.nth(0).locator(".inbox-row-open").click();
  await expect(actions(0)).toBeVisible();
  await expect(actions(3)).toBeHidden();
  await rows.nth(3).hover({ position: { x: 300, y: 10 } });
  await expect(actions(3)).toBeVisible();
  await expect(actions(2)).toBeHidden();

  // They sit in their own column: never over the title or any other cell, and aligned on one right edge.
  const box = async (locator: ReturnType<typeof rows.locator>) => (await locator.boundingBox())!;
  for (const index of [0, 3]) {
    const buttons = await box(actions(index));
    for (const cell of [".c-title", ".c-due", ".c-product"]) {
      if (!await rows.nth(index).locator(cell).count()) continue; // the 2-line layout has no Due or Product cells
      const other = await box(rows.nth(index).locator(cell));
      expect(buttons.x >= other.x + other.width - 0.5 || buttons.x + buttons.width <= other.x + 0.5, `${cell} overlaps the buttons`).toBe(true);
    }
  }
  expect(Math.round((await box(actions(0))).x)).toBe(Math.round((await box(actions(3))).x));

  // Accept on a row that is not open: it is accepted, the open item stays, focus moves to the next row.
  const [first, second, third] = [await titleOf(0), await titleOf(1), await titleOf(2)];
  await rows.nth(1).hover({ position: { x: 300, y: 10 } });
  await rows.nth(1).getByRole("button", { name: `Accept proposal: ${second}` }).click();
  await expect(toast("Proposal accepted")).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(heading).toHaveText(first);
  await expect(queue.locator(".inbox-row.focused")).toContainText(third);

  // The buttons do not open or tick the row.
  await expect(queue.getByLabel(`Select proposal: ${third}`)).not.toBeChecked();

  // Open (the arrow) opens the row it belongs to.
  await rows.nth(1).hover({ position: { x: 300, y: 10 } });
  await rows.nth(1).getByRole("button", { name: `Open in reading pane: ${third}` }).click();
  await expect(heading).toHaveText(third);

  // Reject on the last row: confirmed to be rejected, focus lands on the one above.
  const last = await titleOf(2);
  await rows.nth(2).hover({ position: { x: 300, y: 10 } });
  await rows.nth(2).getByRole("button", { name: `Reject proposal: ${last}` }).click();
  await expect(rows).toHaveCount(2);
  await expect(toast("Proposal rejected")).toBeVisible();

  // Group Accept all acts on every item of the group (the search keeps this group to these items).
  const header = queue.locator(".inbox-source-head").first();
  const accept = header.getByRole("button", { name: /^Accept all in / });
  await page.mouse.move(0, 0);
  await expect(header.locator(".inbox-group-actions")).toHaveCSS("opacity", "0"); // transparent until the header is hovered or focused
  await header.hover();
  await expect(header.locator(".inbox-group-actions")).toHaveCSS("opacity", "1");
  await accept.click();
  await expect(rows).toHaveCount(0);
  await expect(toast("2 proposals accepted")).toBeVisible();
});
