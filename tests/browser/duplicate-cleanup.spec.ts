import { expect, test } from "@playwright/test";
import { recordUrl } from "./fixtures.js";

// Duplicate clean-up from the People settings, in the real built app over synthetic data.
const create = async (request: import("@playwright/test").APIRequestContext, fields: Record<string, unknown>) =>
  (await (await request.post("/api/v1/entities/person", { data: { fields } })).json()) as { frontmatter: { id: string } };

test("finds a name-only duplicate unticked, merges it once ticked, after a backup", async ({ page, request }) => {
  await create(request, { title: "Robin Twofold", given_name: "Robin", family_name: "Twofold" });
  await create(request, { title: "Robin Twofold", given_name: "Robin", family_name: "Twofold" });
  await page.goto(recordUrl("Settings", "settings-people-duplicates"));
  const card = page.getByRole("region", { name: "Clean up duplicates" });
  await card.getByRole("button", { name: "Find duplicates" }).click();

  const row = card.getByRole("listitem").filter({ hasText: 'Merge "Robin Twofold" into "Robin Twofold"' });
  await expect(row).toContainText("Same name only: check before merging");
  const box = row.getByRole("checkbox");
  await expect(box).not.toBeChecked();
  await box.check();

  const apply = card.getByRole("button", { name: /^Back up and apply \d+$/ });
  await apply.click();
  await expect(card.getByRole("status")).toContainText(/Backed up first\. Merged [1-9]/);
  const people = (await (await request.get("/api/v1/entities/person")).json()) as Array<{ frontmatter: { title: string } }>;
  expect(people.filter((person) => person.frontmatter.title === "Robin Twofold")).toHaveLength(1);
});
