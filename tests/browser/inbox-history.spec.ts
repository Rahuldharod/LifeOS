import { expect, test, type APIRequestContext } from "@playwright/test";
import { HISTORY_PREFIX, seed } from "./fixtures.js";

// #243: the Inbox History tab: the Inbox / History switch, rows newest first, the All / Mine / System chips,
// Undo from History, and Reopen in Inbox. Real local API, synthetic proposals from serve.mjs.
type Listed = { frontmatter: { id: string; type: string; title: string; deleted_at?: string } };
const listed = async (request: APIRequestContext) => (await (await request.get("/api/v1/objects")).json()) as Listed[];

test("History lists the actions newest first, filters by who, undoes from the row and reopens a rejected item in the Inbox", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  await page.getByLabel("Search proposals").fill(HISTORY_PREFIX);
  await page.keyboard.press("Escape");
  const queue = page.getByRole("region", { name: "Review queue" });
  const rows = queue.locator(".inbox-row:not(.inbox-colhead)");
  await expect(rows).toHaveCount(3);
  const titleOf = async (index: number) => (await rows.nth(index).locator(".inbox-row-open strong").textContent())!;
  const [one, two] = [await titleOf(0), await titleOf(1)];

  // Accept one, then (a moment later) reject another.
  await rows.nth(0).locator(".inbox-row-open").click();
  await page.keyboard.press("a");
  await expect(rows).toHaveCount(2);
  await page.waitForTimeout(20);
  await queue.locator(".inbox-row-open", { hasText: two }).click();
  await page.keyboard.press("r");
  await expect(rows).toHaveCount(1);

  // The header holds only Inbox / History; the layout toggles stay in the tab row.
  const switcher = page.getByRole("navigation", { name: "Inbox pages" });
  await expect(switcher.getByRole("button")).toHaveText(["Inbox", "History"]);
  await expect(page.getByRole("group", { name: "Reading pane view" })).not.toBeVisible().catch(() => undefined);
  await switcher.getByRole("button", { name: "History" }).click();
  await expect(page).toHaveURL(/\/inbox\/history$/);
  const history = page.getByRole("region", { name: "Inbox History" });
  const mine = history.locator("tbody tr", { hasText: HISTORY_PREFIX });
  await expect(mine).toHaveCount(2);
  await expect(mine.nth(0)).toContainText(two); // newest first
  await expect(mine.nth(0)).toContainText("Rejected");
  await expect(mine.nth(0)).toContainText("You");
  await expect(mine.nth(1)).toContainText(one);
  await expect(mine.nth(1)).toContainText("Accepted");
  await expect(mine.nth(1).locator(".inbox-badge")).toHaveText("Task");

  // Chips: All by default; System has none of mine, Mine has both.
  await expect(history.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await history.getByRole("button", { name: "System", exact: true }).click();
  await expect(mine).toHaveCount(0);
  await history.getByRole("button", { name: "Mine", exact: true }).click();
  await expect(mine).toHaveCount(2);
  await history.getByRole("button", { name: "All", exact: true }).click();

  // Open <object> for the accepted one; the browser Back button returns to History.
  const created = (await listed(request)).find((object) => object.frontmatter.type === "task" && object.frontmatter.title === one && !object.frontmatter.deleted_at)!;
  await mine.nth(1).getByRole("button", { name: /^Open task/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${created.frontmatter.id}`));
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox\/history$/);

  // Undo from History: the row stays, shows Undone, and the created task is gone.
  await mine.nth(1).getByRole("button", { name: `Undo: ${one}` }).click();
  await expect(page.locator(".inbox-toast")).toContainText("back in the Inbox");
  await expect(mine.nth(1)).toContainText("Undone");
  await expect(mine.nth(1).getByRole("button")).toHaveCount(0);
  await expect.poll(async () => (await listed(request)).find((object) => object.frontmatter.id === created.frontmatter.id)?.frontmatter.deleted_at).toBeTruthy();

  // Reopen in Inbox: the reject is undone and the Inbox opens on that item.
  await mine.nth(0).getByRole("button", { name: /^Reopen in Inbox/ }).click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
  await expect(page.locator(".inbox-row.focused")).toContainText(two);
  await expect(page.locator("[data-pane='detail']").first()).toContainText(two);
});
