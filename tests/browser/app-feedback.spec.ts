import { expect, test } from "@playwright/test";
import { recordUrl, seed } from "./fixtures.js";

// PB-018 / ADR 0022: the Feedback button beside Settings opens a popup; Send saves one file through the real server.

test("sends feedback from the nav bar with the page and open object, and shows a toast", async ({ page, request }) => {
  const data = await seed(request);
  const task = data.tasks[0]!;
  await page.goto(recordUrl("Tasks", task.id));
  await expect(page.getByText(task.title).first()).toBeVisible();

  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  const send = dialog.getByRole("button", { name: "Send", exact: true });
  await expect(dialog.getByLabel("Feature")).toBeChecked();
  await expect(send).toBeDisabled();

  await dialog.getByLabel("Feedback", { exact: true }).fill("The task list jumps when I scroll");
  await dialog.getByLabel("Bug").check();
  const sent = page.waitForRequest((candidate) => candidate.url().endsWith("/api/v1/feedback") && candidate.method() === "POST");
  await send.click();
  expect((await sent).postDataJSON()).toEqual({ label: "bug", text: "The task list jumps when I scroll", page: "Tasks", object: `lifeos://object/${task.id}` });

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Feedback saved" })).toBeVisible();
});

test("leaves the object out on a page with no open object and closes on Escape", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByLabel("Feedback", { exact: true }).fill("A feature idea");
  const sent = page.waitForRequest((candidate) => candidate.url().endsWith("/api/v1/feedback"));
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body).toEqual({ label: "feature", text: "A feature idea", page: "Today" });

  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("keeps the popup open with the text and an error when the save fails", async ({ page }) => {
  await page.route("**/api/v1/feedback", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not save feedback: disk full" }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByLabel("Feedback", { exact: true }).fill("Do not lose this");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not save feedback: disk full");
  await expect(dialog.getByLabel("Feedback", { exact: true })).toHaveValue("Do not lose this");
});

// PB-018 (#201): the popup has a bottom-right handle; the size is kept per device and double-click resets it.
test("resizes the popup by its corner handle, remembers it after reload and resets on double-click", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  const handle = dialog.getByRole("separator");
  const size = async () => (await dialog.boundingBox())!;
  const defaultSize = await size();

  const grab = (await handle.boundingBox())!;
  const from = { x: grab.x + grab.width / 2, y: grab.y + grab.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 100, from.y + 120, { steps: 5 });
  await page.mouse.up();
  const grown = await size();
  expect(grown.width).toBeGreaterThan(defaultSize.width + 150);
  expect(grown.height).toBeGreaterThan(defaultSize.height + 100);
  await expect(dialog.getByLabel("Feedback", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Send feedback" }).click();
  const remembered = await size();
  expect(remembered.width).toBeCloseTo(grown.width, 0);
  expect(remembered.height).toBeCloseTo(grown.height, 0);

  await dialog.getByRole("separator").dblclick();
  const reset = await size();
  expect(reset.width).toBeCloseTo(defaultSize.width, 0);
  expect(reset.height).toBeCloseTo(defaultSize.height, 0);
});

test("never grows past the window or below the size that keeps Send visible", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  const grab = (await dialog.getByRole("separator").boundingBox())!;
  await page.mouse.move(grab.x + 10, grab.y + 10);
  await page.mouse.down();
  await page.mouse.move(2000, 2000, { steps: 4 });
  await page.mouse.up();
  const big = (await dialog.boundingBox())!;
  expect(big.x + big.width).toBeLessThanOrEqual(1000);
  expect(big.y + big.height).toBeLessThanOrEqual(700);

  const small = (await dialog.getByRole("separator").boundingBox())!;
  await page.mouse.move(small.x + 10, small.y + 10);
  await page.mouse.down();
  await page.mouse.move(0, 0, { steps: 4 });
  await page.mouse.up();
  await expect(dialog.getByLabel("Feedback", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Bug")).toBeVisible();
});
