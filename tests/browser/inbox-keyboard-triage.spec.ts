import { expect, test } from "@playwright/test";
import { seed, TRIAGE_PREFIX } from "./fixtures.js";

// #238: the Focused item (keys act on it) is separate from the Open item (the reading pane shows it). Real local API, synthetic proposals from serve.mjs.
test("arrows move focus without opening; A and R act on the focused item and focus moves on; X, ranges, Esc and ? work", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/inbox");
  await page.getByLabel("Search proposals").fill(TRIAGE_PREFIX);
  await page.keyboard.press("Escape"); // shortcuts never fire while typing; Esc leaves the search box
  const queue = page.getByRole("region", { name: "Review queue" });
  const rows = queue.getByRole("button", { name: /^Open proposal: Triage proposal/ });
  await expect(rows).toHaveCount(4);
  const titles = (await rows.allTextContents()).map((text) => text.match(/Triage proposal \d/)![0]);
  const heading = page.getByRole("region", { name: "Review detail" }).getByRole("heading", { level: 2 });
  const focusedRow = queue.locator(".inbox-row.focused");
  const openRow = queue.locator(".inbox-row.selected");
  const toast = (text: string) => page.getByRole("status").filter({ hasText: text });
  const ticked = (title: string) => page.getByLabel(`Select proposal: ${title}`);

  // Focus vs open: two arrow presses move the visible focus, the reading pane stays.
  await rows.first().click();
  await expect(heading).toHaveText(titles[0]!);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(focusedRow).toContainText(titles[2]!);
  await expect(rows.nth(2)).toBeFocused();
  await expect(openRow).toContainText(titles[0]!);
  await expect(heading).toHaveText(titles[0]!);
  await expect(focusedRow).toHaveCSS("outline-style", "solid"); // focus is an outline, open is a bar: two different cues
  await expect(openRow).not.toHaveCSS("box-shadow", "none");
  await expect(openRow).toHaveCSS("outline-style", "none");

  // A acts on the focused item while another one stays open; focus moves to the next item.
  await page.keyboard.press("a");
  await expect(toast("Proposal accepted")).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(heading).toHaveText(titles[0]!);
  await expect(focusedRow).toContainText(titles[3]!);

  // The last item rejected: focus lands on the one above.
  await page.keyboard.press("r");
  await expect(rows).toHaveCount(2);
  await expect(focusedRow).toContainText(titles[1]!);
  await expect(heading).toHaveText(titles[0]!);

  // Enter opens the focused item.
  await page.keyboard.press("Enter");
  await expect(heading).toHaveText(titles[1]!);

  // X ticks the focused item; Shift+X ticks a range; Esc clears the ticks.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("x");
  await expect(ticked(titles[0]!)).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+X");
  await expect(ticked(titles[1]!)).toBeChecked();
  await expect(queue.getByText("2 selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ticked(titles[0]!)).not.toBeChecked();
  await expect(ticked(titles[1]!)).not.toBeChecked();

  // ? lists every shortcut; typing in a field never triggers one.
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Inbox keyboard shortcuts" });
  await expect(sheet).toContainText("Move focus");
  await expect(sheet).toContainText("Shift + X or Shift + click");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.getByLabel("Search proposals").focus();
  await page.keyboard.type("ax?");
  await expect(rows).toHaveCount(0); // the text went into the search box, nothing was accepted or ticked
  await page.getByLabel("Search proposals").fill(TRIAGE_PREFIX);
  await expect(rows).toHaveCount(2);
  await expect(sheet).toBeHidden();
});
