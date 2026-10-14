import { expect, test } from "@playwright/test";
import { recordUrl } from "./fixtures.js";

// #213: Manual merge from the People card, in the real built app over synthetic data.
type Person = { frontmatter: { id: string; title: string } };
const create = async (request: import("@playwright/test").APIRequestContext, fields: Record<string, unknown>) =>
  (await (await request.post("/api/v1/entities/person", { data: { fields } })).json()) as Person;

test("merges two people from the People card: pick by name, swap the kept name, confirm", async ({ page, request }) => {
  const named = await create(request, { title: "Morgan Mergeable", given_name: "Morgan", family_name: "Mergeable" });
  const emailOnly = await create(request, { title: "Mmergeable" });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto(recordUrl("People", named.frontmatter.id));
  await page.getByRole("button", { name: "Merge with…" }).click();

  const dialog = page.getByRole("dialog", { name: /Merge Morgan Mergeable with another person/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search people to merge with").fill("mmergeable");
  await dialog.getByRole("button", { name: /Merge with Mmergeable/ }).click();

  // Default: the person with the family name is kept and its name too; the other name becomes an alias.
  const result = dialog.getByLabel("Result of the merge");
  await expect(result).toContainText("Morgan Mergeable");
  await expect(result).toContainText("Mmergeable");
  await expect(dialog.getByRole("radio", { name: "Morgan Mergeable" }).first()).toBeChecked();

  // Swap the kept name: the result follows.
  await dialog.locator("input[name='merge-name']").nth(1).check();
  await expect(result.locator("dd").first()).toHaveText("Mmergeable");
  await expect(result).toContainText("Morgan Mergeable");

  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("People merged")).toBeVisible();
  // The kept person is open, with the discarded name searchable as an alias.
  await expect(page.getByRole("heading", { name: "Mmergeable" })).toBeVisible();
  await page.getByLabel("Search People").fill("Morgan");
  await expect(page.getByRole("button", { name: /Open person: Mmergeable/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open person: Morgan Mergeable/ })).toHaveCount(0);
  expect(emailOnly.frontmatter.id).not.toBe(named.frontmatter.id);
});
