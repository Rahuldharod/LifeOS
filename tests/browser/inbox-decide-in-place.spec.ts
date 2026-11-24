import { expect, test } from "@playwright/test";
import { seed, IN_PLACE_PREFIX } from "./fixtures.js";

// PB-046: decide the Focused row in place. Real local API, synthetic proposals from serve.mjs.
test("A in List view animates the row out, Undo slides it back; in Split view A asks which item and Esc cancels", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  await page.getByLabel("Search proposals").fill(IN_PLACE_PREFIX);
  await page.keyboard.press("Escape");
  const queue = page.getByRole("region", { name: "Review queue" });
  const rows = queue.getByRole("button", { name: /^Open proposal: In place proposal/ });
  await expect(rows).toHaveCount(4);
  const titles = (await rows.allTextContents()).map((text) => text.match(/In place proposal \d/)![0]);
  const rowOf = (title: string) => queue.locator(".inbox-row", { hasText: title });

  // List view: nothing is open, so A acts on the Focused row without asking or opening it.
  await page.keyboard.press("v");
  await expect(page.getByRole("region", { name: "Review detail" })).toBeHidden();
  await rows.first().focus();
  const leaving = rowOf(titles[0]!).evaluate((element) => new Promise<boolean>((resolve) => {
    const seen = () => element.classList.contains("leaving");
    if (seen()) { resolve(true); return; }
    new MutationObserver(() => { if (seen()) resolve(true); }).observe(element, { attributes: true, attributeFilter: ["class"] });
  }));
  await page.keyboard.press("a");
  expect(await leaving).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Proposal accepted" })).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Review detail" })).toBeHidden();
  await expect(queue.locator(".inbox-row.focused")).toContainText(titles[1]!);

  // Undo (Z) brings it back, sliding into its place.
  await page.keyboard.press("z");
  await expect(rowOf(titles[0]!)).toHaveClass(/arriving/);
  await expect(rows).toHaveCount(4);
  await expect(rowOf(titles[0]!)).not.toHaveClass(/arriving/);

  // Split view: open one item, focus another; A asks, Esc cancels and nothing is decided.
  await page.keyboard.press("v");
  await rows.first().click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("a");
  const applyTo = page.getByRole("dialog", { name: "Accept: apply to which item?" });
  await expect(applyTo).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("apply-to.png") });
  await page.keyboard.press("Escape");
  await expect(applyTo).toBeHidden();
  await expect(rows).toHaveCount(4);

  // O applies to the Open item.
  await page.keyboard.press("a");
  await page.keyboard.press("o");
  await expect(rows).toHaveCount(3);
  await expect(rowOf(titles[0]!)).toHaveCount(0);
});
