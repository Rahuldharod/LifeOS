import { expect, test } from "@playwright/test";
import { recordUrl } from "./fixtures.js";

// #214: edit a Person's emails on the People card, in the real built app over synthetic data.
type Person = { frontmatter: { id: string; title: string }; contentHash: string };
const create = async (request: import("@playwright/test").APIRequestContext, fields: Record<string, unknown>) =>
  (await (await request.post("/api/v1/entities/person", { data: { fields } })).json()) as Person;

test("adds and removes an email, warns before removing, and offers a merge for an address on another person", async ({ page, request }) => {
  const ada = await create(request, { title: "Ada Emailtest" });
  const grace = await create(request, { title: "Grace Emailtest" });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto(recordUrl("People", ada.frontmatter.id));

  const emails = page.getByRole("group", { name: "Email addresses" });
  await emails.getByLabel("Add email address").fill("  Ada.Emailtest@Example.COM ");
  await emails.getByRole("button", { name: "Add email" }).click();
  await expect(emails.getByText("ada.emailtest@example.com")).toBeVisible();

  // Another person's address is refused and offers the merge, opened on the preview for that person.
  await page.goto(recordUrl("People", grace.frontmatter.id));
  await emails.getByLabel("Add email address").fill("ada.emailtest@example.com");
  await emails.getByRole("button", { name: "Add email" }).click();
  await expect(emails.getByRole("alert")).toContainText("This belongs to Ada Emailtest — merge instead?");
  await expect(emails.getByText("ada.emailtest@example.com")).toHaveCount(0);
  await emails.getByRole("button", { name: "Merge with Ada Emailtest" }).click();
  const dialog = page.getByRole("dialog", { name: /Merge Grace Emailtest with another person/ });
  await expect(dialog.getByLabel("Result of the merge")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Removing warns first; nothing is saved until confirmed.
  await page.goto(recordUrl("People", ada.frontmatter.id));
  await emails.getByRole("button", { name: "Remove ada.emailtest@example.com" }).click();
  const warning = page.getByRole("alertdialog", { name: /Remove ada.emailtest@example.com\?/ });
  await expect(warning).toContainText("a future invite from this address will create a new unreviewed person");
  await warning.getByRole("button", { name: "Keep it" }).click();
  await expect(emails.getByText("ada.emailtest@example.com")).toBeVisible();
  await emails.getByRole("button", { name: "Remove ada.emailtest@example.com" }).click();
  await warning.getByRole("button", { name: "Yes, remove it" }).click();
  await expect(emails.getByText("ada.emailtest@example.com")).toHaveCount(0);
  await expect(emails.getByText("No email address yet.")).toBeVisible();
});
