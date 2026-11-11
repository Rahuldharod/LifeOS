import { expect, test } from "@playwright/test";
import { AUTO_ADVANCE_PREFIX, seed } from "./fixtures.js";

// PB-035 (#227): after a decision the Inbox opens the next waiting proposal. Real local API, synthetic proposals from serve.mjs.
test("accept and reject move to the next proposal; arrows and Previous/Next move between them", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  await page.getByLabel("Search proposals").fill(AUTO_ADVANCE_PREFIX);
  const rows = page.getByRole("button", { name: /^Open proposal: Auto-advance proposal/ });
  await expect(rows).toHaveCount(3);
  const titles = (await rows.allTextContents()).map((text) => text.match(/Auto-advance proposal \d/)![0]);
  const heading = page.getByRole("region", { name: "Review detail" }).getByRole("heading", { level: 2 });

  await rows.first().click();
  await expect(heading).toHaveText(titles[0]!);
  await expect(page.getByRole("button", { name: "Previous proposal" })).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await expect(heading).toHaveText(titles[1]!);
  await page.getByRole("button", { name: "Next proposal" }).click();
  await expect(heading).toHaveText(titles[2]!);
  await expect(page.getByRole("button", { name: "Next proposal" })).toBeDisabled();
  await page.keyboard.press("ArrowUp");
  await expect(heading).toHaveText(titles[1]!);

  // Middle item accepted: the item below opens and the URL follows it.
  await page.getByRole("button", { name: "Accept task" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Proposal accepted" })).toBeVisible();
  await expect(heading).toHaveText(titles[2]!);
  await expect(page).toHaveURL(/\/inbox\/[^/]+$/);
  await expect(rows).toHaveCount(2);

  // Bottom item rejected: the item above opens.
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(heading).toHaveText(titles[0]!);

  // Last visible item: other proposals are hidden by the search, so the Inbox offers to clear it.
  await page.getByRole("button", { name: "Reject" }).click();
  const queue = page.getByRole("region", { name: "Review queue" });
  await expect(queue).toContainText("No matching proposals");
  await expect(page).toHaveURL(/\/inbox$/);
  await queue.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByLabel("Search proposals")).toHaveValue("");
  await expect(heading).toBeVisible();
});
