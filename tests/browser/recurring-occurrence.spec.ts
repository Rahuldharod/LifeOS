import { expect, test } from "@playwright/test";
import { RECURRING_NOTE, seed } from "./fixtures.js";

test("a recurring Note keeps occurrence context through history editing and narrow navigation", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/notes/${RECURRING_NOTE.id}#${RECURRING_NOTE.currentSectionId}`);
  await expect(page.locator(".application-shell")).toBeVisible();

  const workspace = page.getByRole("region", { name: "Recurring meeting occurrences" });
  const current = workspace.locator("details").filter({ has: page.getByText("Monday, October 12, 2026") });
  await expect(current).toHaveAttribute("open", "");
  await expect(current).toHaveClass(/selected/);
  await expect(current.locator("[aria-label='Saved event snapshot']")).toContainText("Weekly planning");
  await expect(current.getByRole("heading", { name: "Materials" }).locator("..")).toContainText("Synthetic planning transcript");
  await expect(current.getByRole("heading", { name: "Accepted summary" }).locator("..")).toContainText("Agreed the synthetic launch plan");
  await expect(current.getByRole("textbox", { name: "Proposed title" })).toHaveValue(
    "Send the synthetic agenda",
  );

  const older = workspace.locator("details").filter({ has: page.getByText("Monday, October 5, 2026") });
  await expect(older).not.toHaveAttribute("open", "");
  await older.locator("summary").click();
  await expect(page).toHaveURL(new RegExp(`#${RECURRING_NOTE.olderSectionId}$`));
  const notes = older.getByRole("textbox", { name: `Notes for ${RECURRING_NOTE.olderSectionId}` });
  await notes.fill("Historical note edited in the browser.");
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.locator(".save-state")).toContainText("Saved to Markdown");
  await expect(page).toHaveURL(new RegExp(`#${RECURRING_NOTE.olderSectionId}$`));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#${RECURRING_NOTE.olderSectionId}$`));
  await expect(page.getByRole("textbox", { name: `Notes for ${RECURRING_NOTE.olderSectionId}` })).toHaveValue("Historical note edited in the browser.");

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole("button", { name: "Back to notes" })).toBeVisible();
  await expect(page.getByLabel("Notes list", { exact: true })).toBeHidden();
  await expect(page.locator("details.selected")).toContainText("Monday, October 5, 2026");
  await page.getByRole("button", { name: "Back to notes" }).click();
  await expect(page.getByLabel("Notes list", { exact: true })).toBeVisible();
});
