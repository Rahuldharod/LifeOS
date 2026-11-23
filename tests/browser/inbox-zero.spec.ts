import { expect, test } from "@playwright/test";
import { seed } from "./fixtures.js";

// #244: when nothing is waiting, the Inbox shows Inbox zero with today's count and a See History button.
// The synthetic server is shared by every spec, so the test rejects everything pending and then puts it all back with Undo (ADR 0025).
test("rejecting the last waiting items shows Inbox zero; See History opens History; the items are restored afterwards", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  const queue = page.getByRole("region", { name: "Review queue" });
  const rows = queue.locator(".inbox-row:not(.inbox-colhead)");
  await expect(rows.first()).toBeVisible();
  const ids = await queue.locator("[data-review-id]").evaluateAll((elements) => [...new Set(elements.map((element) => (element as HTMLElement).dataset.reviewId!))]);

  // A filter that hides everything is not Inbox zero.
  await page.getByLabel("Search proposals").fill("zzz no such proposal");
  await expect(queue.getByRole("heading", { name: "No matching proposals" })).toBeVisible();
  await expect(queue.getByRole("heading", { name: "Inbox zero" })).toHaveCount(0);
  await queue.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows.first()).toBeVisible();

  try {
    await queue.getByRole("button", { name: "Select all", exact: true }).click();
    await queue.getByRole("button", { name: /^Reject selected/ }).click();
    const zero = queue.getByRole("heading", { name: "Inbox zero" });
    await expect(zero).toBeVisible();
    await expect(zero).toBeFocused();
    await expect(queue).toContainText(/You processed \d+ items? today\./);

    await queue.getByRole("button", { name: "See History" }).click();
    await expect(page).toHaveURL(/\/inbox\/history$/);
    await expect(page.getByRole("region", { name: "Inbox History" })).toBeVisible();
  } finally {
    for (const id of ids) await request.post(`/api/v1/review-items/${id}/undo`, { data: {} });
  }
  await page.goto("/inbox");
  await expect(rows.first()).toBeVisible();
});
