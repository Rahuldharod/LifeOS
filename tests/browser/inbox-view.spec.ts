import { expect, test, type Page } from "@playwright/test";
import { seed } from "./fixtures.js";

// #240: the Inbox list has no maximum width (the reading pane keeps 360px), and a Split / List view that is remembered per Mac.
// Real local API, synthetic proposals from serve.mjs.
test.describe("Inbox Split / List view and divider", () => {
  test.beforeEach(async ({ request }) => { await seed(request); });

  const queue = (page: Page) => page.getByRole("region", { name: "Review queue" });
  const detail = (page: Page) => page.getByRole("region", { name: "Review detail" });
  const divider = (page: Page) => page.getByRole("separator", { name: /Resize list/ });
  const view = (page: Page) => page.getByRole("group", { name: "Reading pane view" });
  const open = async (page: Page, width = 1600) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/inbox");
    await expect(queue(page).locator(".inbox-row:not(.inbox-colhead)").first()).toBeVisible();
  };
  const widthOf = async (locator: ReturnType<typeof queue>) => Math.round((await locator.boundingBox())!.width);

  test("the divider drags until the reading pane reaches 360px and the list keeps a 380px minimum", async ({ page }) => {
    await open(page);
    const box = (await divider(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(1595, y, { steps: 8 });
    await page.mouse.up();
    // Far beyond the old 900px cap, with exactly 360px left for the reading pane.
    expect(await widthOf(queue(page))).toBeGreaterThan(900);
    expect(Math.abs((await widthOf(detail(page))) - 360)).toBeLessThanOrEqual(1);

    const edge = (await divider(page).boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(300, y, { steps: 8 });
    await page.mouse.up();
    expect(Math.abs((await widthOf(queue(page))) - 380)).toBeLessThanOrEqual(1);

    // The keyboard reaches the same limit.
    await divider(page).focus();
    await page.keyboard.press("End");
    expect(Math.abs((await widthOf(detail(page))) - 360)).toBeLessThanOrEqual(1);
  });

  test("the toggle, V and double-clicking the divider switch views; List opens an item in place and Esc or Back returns", async ({ page }) => {
    await open(page);
    await expect(view(page).getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
    await expect(detail(page)).toBeVisible();

    await view(page).getByRole("button", { name: "List" }).click();
    await expect(view(page).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await expect(detail(page)).toBeHidden();
    await expect(divider(page)).toHaveCount(0);
    expect(Math.abs((await widthOf(queue(page))) - (await page.locator(".inbox-workspace").evaluate((node) => Math.round(node.getBoundingClientRect().width))))).toBeLessThanOrEqual(2);
    // Full width gives the one-line row layout under Auto.
    await expect(queue(page)).toHaveClass(/one-line/);

    // A click opens the item full width in place of the list; Back returns with focus on that row.
    const second = queue(page).locator(".inbox-row:not(.inbox-colhead) .inbox-row-open").nth(1);
    const label = await second.getAttribute("aria-label");
    await second.click();
    await expect(queue(page)).toBeHidden();
    await expect(detail(page)).toBeVisible();
    await detail(page).getByRole("button", { name: "Back to review queue" }).click();
    await expect(queue(page)).toBeVisible();
    await expect(page.getByRole("button", { name: label! })).toBeFocused();

    // Enter opens the focused item; Esc returns.
    await page.keyboard.press("Enter");
    await expect(queue(page)).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(queue(page)).toBeVisible();
    await expect(page.getByRole("button", { name: label! })).toBeFocused();

    // V goes back to Split, and the double-click goes to List.
    await page.keyboard.press("v");
    await expect(detail(page)).toBeVisible();
    await expect(queue(page)).toBeVisible();
    await divider(page).dblclick();
    await expect(detail(page)).toBeHidden();
    await expect(view(page).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });

  test("the width and the view survive a reload, and Split brings back the dragged width", async ({ page }) => {
    await open(page);
    await divider(page).focus();
    await page.keyboard.press("End");
    const dragged = await widthOf(queue(page));
    await page.keyboard.press("v");
    await expect(detail(page)).toBeHidden();
    await page.reload();
    await expect(queue(page).locator(".inbox-row:not(.inbox-colhead)").first()).toBeVisible();
    await expect(view(page).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await expect(detail(page)).toBeHidden();
    await page.keyboard.press("v");
    await expect(detail(page)).toBeVisible();
    expect(Math.abs((await widthOf(queue(page))) - dragged)).toBeLessThanOrEqual(1);
  });

  test("narrow screens keep one pane with no view toggle", async ({ page }) => {
    await open(page, 600);
    await expect(view(page)).toHaveCount(0);
    await expect(divider(page)).toHaveCount(0);
    await expect(queue(page)).toBeVisible();
    await expect(detail(page)).toBeHidden();
  });
});
