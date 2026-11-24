import { expect, test } from "@playwright/test";
import { seed } from "./fixtures.js";

// #237: the Inbox list is grouped by date and Source meeting, every row has a Review kind badge, aligned columns and a full title,
// and Auto row layout follows the list width. Real local API, synthetic proposals from serve.mjs.
test.describe("Inbox grouped list", () => {
  test.beforeEach(async ({ request }) => { await seed(request); });

  test("groups with counts that collapse, kind badges in one column and titles on one left edge", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(() => { try { localStorage.setItem("lifeos.split.inbox", "840"); } catch { /* none */ } });
    await page.goto("/inbox");
    const queue = page.getByRole("region", { name: "Review queue" });
    await expect(queue.locator(".inbox-date").first()).toBeVisible();
    const headers = queue.locator(".inbox-source");
    expect(await headers.count()).toBeGreaterThan(0);
    await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
    await expect(headers.first().locator("small")).toHaveText(/^\d+$/);
    // Source groups are Meeting, Agent run or Other.
    for (const label of await headers.allTextContents()) expect(label).toMatch(/(Meeting|Agent run) · |Other/);

    // Every row has a badge; badges share one left edge, and so do titles, and the title wraps in full.
    const rows = queue.locator(".inbox-row:not(.inbox-colhead)");
    const count = await rows.count();
    expect(count).toBeGreaterThan(3);
    await expect(queue.locator(".inbox-row:not(.inbox-colhead) .inbox-badge")).toHaveCount(count);
    const lefts = async (selector: string) => [...new Set((await queue.locator(selector).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)))))];
    expect(await lefts(".inbox-row:not(.inbox-colhead) .c-kind")).toHaveLength(1);
    expect(await lefts(".inbox-row:not(.inbox-colhead) .c-title")).toHaveLength(1);
    expect(await lefts(".inbox-row:not(.inbox-colhead) .c-actions")).toHaveLength(1);
    const wrap = await queue.locator(".inbox-row-open strong").first().evaluate((node) => { const style = getComputedStyle(node); return [style.whiteSpace, style.textOverflow]; });
    expect(wrap).toEqual(["normal", "clip"]);

    // Collapsing a group hides its rows and keeps the header with its count.
    const first = headers.first();
    const size = Number(await first.locator("small").textContent());
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await expect(rows).toHaveCount(count - size);
    await first.click();
    await expect(rows).toHaveCount(count);
  });

  test("tabs still filter and group inside the tab", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/inbox");
    const queue = page.getByRole("region", { name: "Review queue" });
    await expect(queue.locator(".inbox-source").first()).toBeVisible();
    await page.getByRole("tab", { name: /^Decision/ }).click();
    const badges = queue.locator(".inbox-row:not(.inbox-colhead) .inbox-badge");
    expect(await badges.count()).toBeGreaterThan(0);
    for (const text of await badges.allTextContents()) expect(text).toBe("Decision");
    await expect(queue.locator(".inbox-source").first()).toBeVisible();
  });

  test("Auto switches between one line with columns and two lines as the list pane is resized, and 1 line / 2 lines override it", async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.addInitScript(() => { try { if (!sessionStorage.getItem("seeded-split")) { sessionStorage.setItem("seeded-split", "1"); localStorage.setItem("lifeos.split.inbox", "1060"); localStorage.removeItem("lifeos.inboxRowLayout"); } } catch { /* none */ } });
    await page.goto("/inbox");
    const queue = page.getByRole("region", { name: "Review queue" });
    const layout = page.getByRole("group", { name: "Row layout" });
    await expect(queue.locator(".inbox-row").first()).toBeVisible();
    expect((await queue.boundingBox())!.width).toBeGreaterThanOrEqual(940);

    // Wide: one line, column header, Owner / Due / Project / Client / Product cells (PB-043: no Time).
    await expect(queue).toHaveClass(/one-line/);
    await expect(queue.locator(".inbox-colhead")).toBeVisible();
    await expect(queue.locator(".inbox-row-sub")).toHaveCount(0);
    await expect(layout.getByRole("button", { name: /^Auto/ })).toContainText("1 line");
    await expect(queue.locator(".inbox-row:not(.inbox-colhead) .c-owner").first()).toBeVisible();
    await expect(queue.locator(".inbox-row:not(.inbox-colhead) .c-product").first()).toBeVisible();
    await expect(queue.locator(".inbox-colhead")).toContainText("Client");
    await expect(queue.locator(".c-time")).toHaveCount(0);

    // Narrow it with the divider (24px a press): the list drops under 940px and Auto flips live to two lines.
    await page.getByRole("separator", { name: /Resize list/ }).focus();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await queue.boundingBox())!.width).toBeLessThan(940);
    await expect(queue).toHaveClass(/two-line/);
    await expect(queue.locator(".inbox-colhead")).toHaveCount(0);
    await expect(queue.locator(".inbox-row-sub").first()).toBeVisible();
    await expect(layout.getByRole("button", { name: /^Auto/ })).toContainText("2 lines");

    // Two lines add no stray height to a row without a second line of text: row heights stay close to a single text line plus the sub line.
    const heights = await queue.locator(".inbox-row:not(.inbox-colhead)").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(Math.max(...heights)).toBeLessThan(120);

    // Forcing 1 line keeps the columns even though the list is narrow; the narrow list drops Product first, without leaving blank height.
    await layout.getByRole("button", { name: "1 line" }).click();
    await expect(queue).toHaveClass(/one-line/);
    const row = queue.locator(".inbox-row:not(.inbox-colhead)").first();
    await expect(row.locator(".c-product")).toBeHidden();
    await expect(row.locator(".c-project")).toBeVisible();
    await expect(row.locator(".c-due")).toBeVisible();
    await layout.getByRole("button", { name: "2 lines" }).click();
    await expect(queue).toHaveClass(/two-line/);
  });

  test("the low-confidence tooltip shows on keyboard focus and a legend explains the dot", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/inbox");
    const queue = page.getByRole("region", { name: "Review queue" });
    await expect(queue.locator(".inbox-legend")).toContainText("Low confidence");
    // The seeded drafts include a Medium and High confidence ones only when none is Low, so the dot is checked when present.
    const dot = queue.locator(".inbox-low[data-tip]").first();
    if (await dot.count()) {
      await dot.focus();
      const tip = await dot.evaluate((node) => getComputedStyle(node, "::after").content);
      expect(tip).toContain("Low confidence");
    }
  });
});
