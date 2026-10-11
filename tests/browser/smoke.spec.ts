import { expect, test } from "@playwright/test";
import { recordUrl, seed } from "./fixtures.js";

test("the built app loads from the real server and lists seeded tasks", async ({ page, request }) => {
  const data = await seed(request);
  expect(data.tasks.length).toBeGreaterThanOrEqual(30);
  expect(data.reviewItems.length).toBeGreaterThanOrEqual(2);
  await page.goto("/");
  await expect(page.locator(".shell-brand").or(page.getByText("LifeOS").first()).first()).toBeVisible();
  await page.goto(recordUrl("Tasks"));
  await expect(page.getByText(data.tasks[0]!.title).first()).toBeVisible();
});
