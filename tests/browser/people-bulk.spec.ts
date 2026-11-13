import { expect, test } from "@playwright/test";
import { recordUrl } from "./fixtures.js";

// #230: People filters, checkboxes and bulk actions, in the real built app over synthetic data.
test("filters people, marks the selected ones external, and archives them after a confirmation", async ({ page, request }) => {
  const create = async (title: string) => (await (await request.post("/api/v1/entities/person", { data: { fields: { title } } })).json()) as { frontmatter: { id: string }; contentHash: string };
  await create("Bulkfilter Ana <bulk-ana@example.com>");
  await create("Bulkfilter Ben <bulk-ben@example.com>");
  const list = await create("Bulkfilter List <bulk-list@example.com>");
  await request.post(`/api/v1/people/${list.frontmatter.id}/not-a-person`, { data: { expectedHash: list.contentHash } });

  await page.goto(recordUrl("People"));
  await page.getByLabel("Search People").fill("Bulkfilter");
  const rows = page.getByRole("button", { name: /^Open person: Bulkfilter/ });
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Type filter").selectOption("not-a-person");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Not a person");
  await page.getByLabel("Type filter").selectOption("person");

  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  // Narrow and compact layouts show the list or the panel, so "Actions…" opens the panel.
  const stacked = await page.getByRole("button", { name: "Actions…" }).isVisible();
  const openPanel = async () => { if (stacked) await page.getByRole("button", { name: "Actions…" }).click(); };
  await openPanel();
  const panel = page.getByRole("region", { name: "Selected people actions" });
  await panel.getByRole("button", { name: "Mark external (2 of 2)" }).click();
  // Done: a toast, and the selection clears so the list is ready for the next batch.
  await expect(page.locator(".people-bulk-toast")).toContainText("2 people marked external");
  await expect(page.getByText("2 shown")).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.getByLabel("Internal or external filter").selectOption("external");
  await expect(rows).toHaveCount(2);
  // The list stays inside its column (#230 follow-up): no row is wider than the list.
  const widths = await page.evaluate(() => ({ list: document.querySelector(".reference-list")!.getBoundingClientRect().right, rows: Math.max(...[...document.querySelectorAll(".reference-rows small")].map((small) => small.getBoundingClientRect().right)) }));
  expect(widths.rows).toBeLessThanOrEqual(widths.list);

  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await openPanel();
  await panel.getByRole("button", { name: "Archive (2 of 2)" }).click();
  const dialog = page.getByRole("dialog", { name: "Archive 2 people?" });
  await expect(dialog).toContainText("Bulkfilter Ana");
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".people-bulk-toast")).toContainText("2 people archived");
});
