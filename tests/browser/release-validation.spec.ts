import { expect, test, type Page } from "@playwright/test";
import { seed } from "./fixtures.js";

const destinations = ["/", "/calendar", "/tasks", "/notes", "/inbox", "/settings"];

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator(".shell-content").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const paneWidths = await page.locator(".pane-workspace").evaluateAll((elements) => elements.map((element) => ({ workspace: element.getAttribute("data-workspace"), scroll: element.scrollWidth, client: element.clientWidth })));
  expect(paneWidths, `horizontal overflow at ${page.url()}`).toEqual(expect.arrayContaining(paneWidths.map(({ workspace, client }) => ({ workspace, scroll: client, client }))));
}

test.beforeAll(async ({ request }) => { await seed(request); });

test("representative workspaces retain landmarks and reflow at narrow and desktop widths", async ({ page }) => {
  for (const viewport of [{ width: 320, height: 640 }, { width: 640, height: 800 }, { width: 1000, height: 800 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const path of destinations) {
      await page.goto(path);
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.locator("#lifeos-content")).toBeVisible();
      await expectNoPageOverflow(page);
      if (viewport.width <= 640) {
        await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
        await expect(page.locator(".shell-topbar-actions").getByRole("button", { name: "Capture", exact: true })).toBeVisible();
      } else await expect(page.getByRole("complementary", { name: "Application navigation" })).toBeVisible();
    }
  }
});

test("keyboard navigation can skip the shell and Search traps then restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tasks");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  const trigger = page.getByRole("complementary", { name: "Application navigation" }).getByRole("button", { name: "Search" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("a narrow task workflow moves focus into detail and returns it to its row", async ({ page, request }) => {
  const data = await seed(request);
  const task = data.tasks[0]!;
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/tasks");
  const row = page.getByRole("button", { name: `Open task: ${task.title}` });
  await row.click();
  const heading = page.locator("[data-pane='detail'] [data-detail-heading]");
  await expect(heading).toHaveText(task.title);
  await expect(heading).toBeFocused();
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await expect(row).toBeFocused();
});

test("narrow Inbox and Settings flows expose a focused detail and a return action", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/inbox");
  const proposal = page.locator(".inbox-row").first();
  await proposal.click();
  await expect(page.locator("[data-pane='detail'] [data-detail-heading]")).toBeFocused();
  await page.getByRole("button", { name: "Back to review queue" }).click();
  await expect(proposal).toBeFocused();

  await page.goto("/settings");
  const section = page.locator(".settings-rail nav button").first();
  await section.click();
  await expect(page.locator("[data-pane='detail'] [data-detail-heading]")).toBeFocused();
  await page.getByRole("button", { name: "Back to settings sections" }).click();
  await expect(section).toBeFocused();
});

test("a narrow Calendar event flow returns to its timeline", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/calendar");
  const event = page.locator(".event").first();
  await expect(event).toBeVisible();
  await event.click();
  await expect(page.getByRole("button", { name: "Back to calendar" })).toBeVisible();
  await page.getByRole("button", { name: "Back to calendar" }).click();
  await expect(event).toBeFocused();
});

test("a narrow Notes flow moves focus into detail and returns it to its row", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/notes");
  const row = page.locator(".note-list-item").first();
  await expect(row).toBeVisible();
  await row.click();
  const heading = page.locator("[data-pane='detail'] .note-header h3");
  await expect(heading).toBeFocused();
  await page.getByRole("button", { name: "Back to notes" }).click();
  await expect(row).toBeFocused();
});

test("Reference Data switches to one working pane when its Settings container is constrained", async ({ page, request }) => {
  const data = await seed(request);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const list = page.getByLabel("Projects list", { exact: true });
  const detail = page.getByLabel("project details", { exact: true });
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  await page.getByRole("button", { name: `Open project: ${data.projects[0]!.title}` }).click();
  await expect(list).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(page.getByRole("heading", { name: data.projects[0]!.title })).toBeFocused();
});

test("a compact Calendar stacks instead of placing detail in the divider track", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/calendar");
  await page.locator(".event").first().click();
  const list = page.getByLabel("Calendar timeline", { exact: true });
  const detail = page.getByLabel("Meeting detail", { exact: true });
  await expect(list).toBeHidden();
  await expect(detail).toBeVisible();
  expect((await detail.boundingBox())!.width).toBeGreaterThan(400);
});

test("a compact Knowledge detail exposes its return action after stacking", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/knowledge");
  const row = page.locator(".knowledge-row").first();
  await row.click();
  await expect(page.getByRole("button", { name: "Back to knowledge" })).toBeVisible();
  await page.getByRole("button", { name: "Back to knowledge" }).click();
  await expect(row).toBeFocused();
});

test("reduced motion retains feedback without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tasks");
  expect(parseFloat(await page.locator(".application-shell").evaluate((element) => getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
});
