import { expect, test } from "@playwright/test";
import { recordUrl } from "./fixtures.js";

// "Not a person" from the People card, and Undo from Settings, Ignored addresses (CONTEXT.md, Ignored address).
test("marks a mailing list as not a person, lists its address as ignored, and undoes it", async ({ page, request }) => {
  const list = (await (await request.post("/api/v1/entities/person", { data: { fields: { title: "Team List <team-list@example.com>" } } })).json()) as { frontmatter: { id: string } };
  await page.goto(recordUrl("People", list.frontmatter.id));
  await page.getByRole("button", { name: "Not a person…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Mark Team List as not a person?" });
  await confirm.getByRole("button", { name: "Not a person", exact: true }).click();
  await expect(page.getByText("Team List archived; its address is now ignored")).toBeVisible();

  await page.goto(recordUrl("Settings", "settings-ignored-addresses"));
  const row = page.locator(".ignored-addresses li").filter({ hasText: "team-list@example.com" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("team-list@example.com is no longer ignored.")).toBeVisible();
  await expect(row).toHaveCount(0);
});
