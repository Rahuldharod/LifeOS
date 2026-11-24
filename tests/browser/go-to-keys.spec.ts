import { expect, test } from "@playwright/test";
import { seed, TRIAGE_PREFIX } from "./fixtures.js";

// PB-045: G then a letter goes to a page; G then I on an open Inbox item goes back to the list with its row focused.
test("G then a letter goes to a page, and G then I closes an open Inbox item back to its row", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/tasks");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("g"); await page.keyboard.press("i");
  await expect(page).toHaveURL(/\/inbox$/);

  // List view: the open item covers the list; G then I closes it and focuses its row.
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByLabel("Search proposals").fill(TRIAGE_PREFIX);
  await page.keyboard.press("Escape");
  const queue = page.getByRole("region", { name: "Review queue" });
  const second = queue.getByRole("button", { name: /^Open proposal: Triage proposal/ }).nth(1);
  const title = (await second.textContent())!.match(/Triage proposal \d/)![0];
  await second.click();
  const heading = page.getByRole("region", { name: "Review detail" }).getByRole("heading", { level: 2 });
  await expect(heading).toHaveText(title);
  await page.keyboard.press("g"); await page.keyboard.press("i");
  await expect(heading).toBeHidden();
  await expect(queue.getByRole("button", { name: new RegExp(`^Open proposal: ${title}`) })).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Priority" })).toHaveCount(0); // I after G is not the Priority key

  // Another page by key, then back.
  await page.keyboard.press("g"); await page.keyboard.press("k");
  await expect(page).toHaveURL(/\/tasks/);
  await expect(page.getByRole("button", { name: "Tasks", exact: true })).toHaveAttribute("aria-current", "page");
});
