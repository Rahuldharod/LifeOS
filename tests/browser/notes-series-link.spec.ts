import { expect, test } from "@playwright/test";
import { seed } from "./fixtures.js";

// #181: real local API, synthetic seed data from serve.mjs.
const SEPTEMBER_NOTE = "b1000000-0000-4000-8000-000000000006";
const SEPTEMBER_MEETING = "a1000000-0000-4000-8000-000000000006";
const LEGACY_NOTE = "d1000000-0000-4000-8000-000000000001";
const LEGACY_NEWEST_MEETING = "c1000000-0000-4000-8000-000000000002";

test("a per-occurrence Note opens alone in the Notes tab and Show series opens its Series view", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/notes/${SEPTEMBER_NOTE}`);
  await expect(page.getByRole("link", { name: "Show series" })).toBeVisible();
  await expect(page.locator(".recurring-occurrence-workspace")).toHaveCount(0);
  await page.getByRole("link", { name: "Show series" }).click();
  await expect(page).toHaveURL(new RegExp(`/calendar/2026-09-07/${SEPTEMBER_MEETING}$`));
  await expect(page.getByRole("region", { name: "Earlier occurrences" })).toBeVisible();
});

test("a Legacy shared Note opens as one plain Note and Show series targets its newest Meeting", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/notes/${LEGACY_NOTE}`);
  await expect(page.getByRole("link", { name: "Show series" })).toBeVisible();
  await expect(page.locator(".recurring-occurrence-workspace, .occurrence-section")).toHaveCount(0);
  await page.getByRole("link", { name: "Show series" }).click();
  await expect(page).toHaveURL(new RegExp(`/calendar/2026-09-14/${LEGACY_NEWEST_MEETING}$`));
});

test("a Note that is not part of a recurring series has no Show series link", async ({ page, request }) => {
  await seed(request);
  await page.goto("/notes");
  await page.getByText("Browser knowledge note 2", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Delete note" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Show series" })).toHaveCount(0);
});
