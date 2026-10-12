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

    // Collapsed by default and expandable.
    await expect(entries.nth(0)).not.toHaveAttribute("open", "");
    await expect(series.getByText("Monthly review words for 2026-08.")).toBeHidden();
    await entries.nth(0).locator("summary").click();
    await expect(series.getByText("Monthly review words for 2026-08.")).toBeVisible();

    // Nothing spills sideways at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("an earlier occurrence shows its own Sources and accepted summary, and no other occurrence does (#176)", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-09-07/${SEPTEMBER}`);
  const entries = page.getByRole("region", { name: "Earlier occurrences" }).locator("details");
  await entries.nth(0).locator("summary").click();
  await expect(entries.nth(0).getByRole("region", { name: "Accepted summary" })).toContainText("August budget approved.");
  await expect(entries.nth(0).getByRole("link", { name: "August review transcript" })).toHaveAttribute("href", "https://drive.example.com/docs/monthly-review-august");
  await entries.nth(1).locator("summary").click();
  await expect(entries.nth(1).getByRole("region", { name: "Sources" })).toHaveCount(0);
  await expect(entries.nth(1).getByRole("region", { name: "Accepted summary" })).toHaveCount(0);
});

test("opening an older occurrence shows only the Notes before it, not the latest ones", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-08-07/${AUGUST}`);
  const entries = page.getByRole("region", { name: "Earlier occurrences" }).locator("details");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0).locator("summary")).toContainText("July 7, 2026");
  await expect(entries.nth(2).locator("summary")).toContainText("April 7, 2026");
});

test("a Legacy shared Note appears once as one block labelled with its date range", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/calendar/2026-09-21/d1000000-0000-4000-8000-000000000002");
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  await expect(series.locator("details")).toHaveCount(1);
  await expect(series.locator("summary")).toContainText("September 7, 2026 to Monday, September 14, 2026");
  await expect(series.locator("summary")).toContainText("Shared Note");
  await series.locator("summary").click();
  await expect(series.getByText("Legacy shared Prio words.")).toBeVisible();
});

// #180: eight weekly occurrences with a Note (the 6th cancelled), a 9th cancelled without a Note.
const WEEKLY = (n: number) => `e1000000-0000-4000-8000-00000000000${n}`;

test("Load older adds 4 occurrences at a time until none remain, and marks a cancelled occurrence", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-04-20/${WEEKLY(8)}`);
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  const entries = series.locator("details");
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0).locator("summary")).toContainText("April 13, 2026");
  await expect(entries.nth(1).locator("summary")).toContainText("April 6, 2026");
  await expect(entries.nth(1).locator("summary")).toContainText("Cancelled");
  await expect(entries.nth(0).locator("summary")).not.toContainText("Cancelled");
  // The cancelled occurrence without a Note (April 27) is hidden; no newer Note exists, so no link either.
  await expect(series).not.toContainText("April 27, 2026");
  await expect(series.getByText("Newer occurrences exist")).toHaveCount(0);

  await series.getByRole("button", { name: "Load older" }).click();
  await expect(entries).toHaveCount(7);
  await expect(entries.nth(6).locator("summary")).toContainText("March 2, 2026");
  await expect(series.getByRole("button", { name: "Load older" })).toHaveCount(0);
});

test("opening an older occurrence offers a link to the newest one with a Note", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-03-30/${WEEKLY(5)}`);
  const series = page.getByRole("region", { name: "Earlier occurrences" });
  await expect(series.locator("details")).toHaveCount(4);
  await expect(series.getByRole("button", { name: "Load older" })).toHaveCount(0);
  await series.getByRole("button", { name: /Open the latest/ }).click();

  await expect(page).toHaveURL(new RegExp(`/calendar/2026-04-20/${WEEKLY(8)}$`));
  await expect(series.locator("details").first().locator("summary")).toContainText("April 13, 2026");
  await expect(series.getByText("Newer occurrences exist")).toHaveCount(0);
});
