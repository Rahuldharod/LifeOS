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
