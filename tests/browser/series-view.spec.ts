import { expect, test } from "@playwright/test";
import { seed } from "./fixtures.js";

// #179: real local API, synthetic seed data from serve.mjs (six monthly occurrences, June has no Note).
const SEPTEMBER = "a1000000-0000-4000-8000-000000000006";
const AUGUST = "a1000000-0000-4000-8000-000000000005";

for (const [label, width] of [["desktop", 1280], ["phone", 390]] as const) {
  test(`the Series view lists the 4 earlier Notes collapsed and expandable at ${label} width`, async ({ page, request }) => {
    await seed(request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/calendar/2026-09-07/${SEPTEMBER}`);

    const series = page.getByRole("region", { name: "Earlier occurrences" });
    const entries = series.locator("details");
    // Newest first; June has no Note, so May and April fill the 4 places.
    await expect(entries).toHaveCount(4);
    await expect(entries.nth(0).locator("summary")).toContainText("August 7, 2026");
    await expect(entries.nth(1).locator("summary")).toContainText("July 7, 2026");
    await expect(entries.nth(2).locator("summary")).toContainText("May 7, 2026");
    await expect(entries.nth(3).locator("summary")).toContainText("April 7, 2026");
    await expect(series).not.toContainText("June 7, 2026");
    await expect(entries.nth(0).locator("summary")).toContainText(/\d{1,2}:\d{2}\s?[AP]M–\d{1,2}:\d{2}\s?[AP]M/);

    // Collapsed by default, expandable, read-only.
    await expect(entries.nth(0)).not.toHaveAttribute("open", "");
    await expect(series.getByText("Monthly review words for 2026-08.")).toBeHidden();
    await entries.nth(0).locator("summary").click();
    await expect(series.getByText("Monthly review words for 2026-08.")).toBeVisible();
    await expect(series.locator("textarea, input")).toHaveCount(0);

    // Nothing spills sideways at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("opening an older occurrence shows only the Notes before it, not the latest ones", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-08-07/${AUGUST}`);
  const entries = page.getByRole("region", { name: "Earlier occurrences" }).locator("details");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0).locator("summary")).toContainText("July 7, 2026");
  await expect(entries.nth(2).locator("summary")).toContainText("April 7, 2026");
});

test("a Legacy shared Note appears once as a read-only block labelled with its date range", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/calendar/2026-09-21/d1000000-0000-4000-8000-000000000002");
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  await expect(series.locator("details")).toHaveCount(1);
  await expect(series.locator("summary")).toContainText("September 7, 2026 to Monday, September 14, 2026");
  await expect(series.locator("summary")).toContainText("Shared Note");
  await series.locator("summary").click();
  await expect(series.getByText("Legacy shared Prio words.")).toBeVisible();
  await expect(series.locator("textarea, input")).toHaveCount(0);
});
