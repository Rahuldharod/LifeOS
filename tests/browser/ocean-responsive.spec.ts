// #154: the ocean visual system and responsive workspace contract, exercised through the built app, the real
// localhost API and synthetic data. Assertions use visible controls, computed bounds, focus and accessible state.
import { expect, test, type Page } from "@playwright/test";
import { recordUrl, seed, type SeedData } from "./fixtures.js";

let data: SeedData;
test.beforeAll(async ({ request }) => { data = await seed(request); });

const ready = async (page: Page) => { await expect(page.locator(".application-shell")).toBeVisible(); await page.waitForLoadState("networkidle"); };
const open = async (page: Page, path: string) => { await page.goto(path); await ready(page); };
const band = (page: Page) => page.locator(".application-shell").getAttribute("data-band");

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main#lifeos-content")!;
    return { page: document.documentElement.scrollWidth - window.innerWidth, workspace: main.scrollWidth - main.clientWidth };
  });
  expect(overflow.page, "page-level horizontal scroll").toBeLessThanOrEqual(0);
  expect(overflow.workspace, "workspace horizontal scroll").toBeLessThanOrEqual(0);
}

async function width(page: Page, selector: string) {
  return (await page.locator(selector).first().boundingBox())!.width;
}

const destinations = ["/", "/tasks", "/calendar", "/notes", "/inbox", "/decisions", "/open-points", "/knowledge", "/settings"];

test.describe("responsive bands follow the usable workspace after the sidebar", () => {
  for (const [viewport, expected] of [
    [{ width: 999, height: 900 }, "narrow"], [{ width: 1000, height: 900 }, "compact"],
    [{ width: 1439, height: 900 }, "compact"], [{ width: 1440, height: 900 }, "standard"],
    [{ width: 2039, height: 900 }, "standard"], [{ width: 2040, height: 900 }, "wide"]
  ] as const) {
    test(`${viewport.width}px wide with the expanded sidebar is ${expected}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, "/tasks");
      expect(await band(page)).toBe(expected);
      await expect(page.getByRole("complementary", { name: "Application navigation" })).toHaveCount(expected === "narrow" ? 0 : 1);
      await expectNoPageOverflow(page);
    });
  }

  test("the short-height treatment starts below 900px and keeps targets comfortable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 899 });
    await open(page, "/tasks");
    await expect(page.locator(".application-shell")).toHaveAttribute("data-height", "short");
    expect((await page.getByRole("button", { name: "New Task" }).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".application-shell")).toHaveAttribute("data-height", "regular");
  });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 2560, height: 1440 }, { width: 320, height: 640 }]) {
    test(`no destination scrolls the page sideways at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const path of destinations) {
        await open(page, path);
        await expectNoPageOverflow(page);
      }
    });
  }

  test("320 CSS px (the 400% reflow equivalent) keeps one working view with global navigation reachable", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, "/tasks");
    for (const name of ["Menu", "Search", "Capture"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Tasks list" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Task detail" })).toBeHidden();
    await page.getByRole("button", { name: "Menu" }).click();
    const sheet = page.getByRole("dialog", { name: "Navigation" });
    await expect(sheet.getByRole("button", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
  });
});

test.describe("bounded canvas, pane clamps and content measures", () => {
  test("the working canvas stops growing near 1,880px and centres on a large display", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await open(page, "/tasks");
    const canvas = (await page.locator(".shell-canvas").boundingBox())!;
    const main = (await page.locator("main#lifeos-content").boundingBox())!;
    expect(canvas.width).toBeLessThanOrEqual(1880);
    expect(Math.abs((canvas.x - main.x) - (main.x + main.width - canvas.x - canvas.width))).toBeLessThanOrEqual(2);
  });

  for (const [path, list, min, max] of [
    ["/tasks", "Tasks list", 460, 640], ["/calendar", "Calendar timeline", 320, 480], ["/notes", "Notes list", 360, 520],
    ["/inbox", "Review queue", 380, 520], ["/decisions", "Decisions list", 380, 560], ["/knowledge", "Knowledge list", 360, 520], ["/settings", "Settings sections", 240, 320]
  ] as const) {
    test(`${list} stays within ${min}–${max}px on a laptop and a large display`, async ({ page }) => {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 2560, height: 1440 }]) {
        await page.setViewportSize(viewport);
        await open(page, path);
        const actual = (await page.getByLabel(list, { exact: true }).boundingBox())!.width;
        expect(actual).toBeGreaterThanOrEqual(min - 1);
        expect(actual).toBeLessThanOrEqual(max + 1);
      }
    });
  }

  test("the divider resizes by keyboard within the clamp, is remembered on this device and resets on double-click", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await open(page, "/tasks");
    const divider = page.getByRole("separator", { name: /Resize list/ });
    await divider.focus();
    await page.keyboard.press("Home");
    expect(Math.round(await width(page, "[aria-label='Tasks list']"))).toBe(460);
    await page.keyboard.press("ArrowRight");
    expect(Math.round(await width(page, "[aria-label='Tasks list']"))).toBe(484);
    await page.keyboard.press("End"); await page.keyboard.press("ArrowRight");
    expect(Math.round(await width(page, "[aria-label='Tasks list']"))).toBe(640);
    await expect(divider).toHaveAttribute("aria-valuenow", "640");
    await page.keyboard.press("ArrowLeft");
    await page.reload(); await ready(page);
    expect(Math.round(await width(page, "[aria-label='Tasks list']"))).toBe(616);
    await page.getByRole("separator", { name: /Resize list/ }).dblclick();
    expect(Math.round(await width(page, "[aria-label='Tasks list']"))).toBe(640);
    expect(await page.evaluate(() => localStorage.getItem("lifeos.split.tasks"))).toBeNull();
  });

  test("the task toolbar wraps before clipping, with search first", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, "/tasks");
    const pane = (await page.getByLabel("Tasks list", { exact: true }).boundingBox())!;
    const controls = page.locator(".task-common-filters > *");
    expect(await controls.first().getAttribute("aria-label")).toBe("Search tasks");
    for (const box of await Promise.all((await controls.all()).map((control) => control.boundingBox()))) {
      expect(box!.x).toBeGreaterThanOrEqual(pane.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
    }
  });

  test("forms and reading content keep their measures inside a wide detail", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await open(page, recordUrl("Tasks", data.tasks[0]!.id));
    expect(await width(page, ".task-form")).toBeLessThanOrEqual(900);
    await open(page, recordUrl("Knowledge", data.longKnowledgeNote.id));
    const [reading, limit] = await page.locator(".knowledge-markdown").evaluate((element) => {
      const probe = element.appendChild(document.createElement("div")); probe.style.width = "75ch";
      const result = [element.getBoundingClientRect().width, probe.getBoundingClientRect().width]; probe.remove(); return result;
    });
    expect(reading).toBeLessThanOrEqual(limit! + 0.5);
  });

  test("list and detail panes scroll independently", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, recordUrl("Tasks", data.tasks[0]!.id));
    const list = page.getByLabel("Tasks list", { exact: true });
    await list.evaluate((element) => { element.scrollTop = 400; });
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator("main#lifeos-content").evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "Save" })).toBeInViewport();
  });
});

test.describe("narrow list → detail navigation and keyboard movement", () => {
  test("opening a record focuses its heading; Back restores the row, its focus and the list scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, "/tasks");
    const list = page.getByLabel("Tasks list", { exact: true });
    const target = data.tasks[20]!;
    const row = page.getByRole("button", { name: `Open task: ${target.title}` });
    await row.scrollIntoViewIfNeeded();
    const scrolled = await list.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await row.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: target.title })).toBeFocused();
    await expect(list).toBeHidden();
    await page.getByRole("button", { name: "Back to tasks" }).click();
    await expect(row).toBeFocused();
    expect(Math.abs(await list.evaluate((element) => element.scrollTop) - scrolled)).toBeLessThanOrEqual(2);
  });

  test("a direct record link opens the detail with Back", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, recordUrl("Decisions", data.decisions[0]!.id));
    await expect(page.getByRole("heading", { name: data.decisions[0]!.title, level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "Back to decisions" }).click();
    await expect(page.getByRole("region", { name: "Decisions list" })).toBeVisible();
  });

  test("the skip link moves focus past navigation to the workspace", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, "/tasks");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#lifeos-content")).toBeFocused();
  });

  test("Search contains focus and returns it to its trigger", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, "/tasks");
    const trigger = page.getByRole("complementary", { name: "Application navigation" }).getByRole("button", { name: "Search" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe("ocean action states", () => {
  const style = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).first().evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, color: computed.color, opacity: computed.opacity, shadow: computed.boxShadow, transform: computed.transform };
  });

  test("primary default, hover, pressed, focus and disabled states are distinct and readable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/tasks");
    const primary = page.getByRole("button", { name: "New Task" });
    expect((await style(page, "New Task")).background).toBe("rgb(18, 62, 90)");
    await primary.hover();
    await expect.poll(async () => (await style(page, "New Task")).background).toBe("rgb(42, 113, 142)");
    expect((await style(page, "New Task")).shadow).not.toBe("none");
    await page.mouse.down();
    await expect.poll(async () => (await style(page, "New Task")).background).toBe("rgb(11, 41, 61)");
    await page.mouse.move(0, 0); await page.mouse.up();
    await page.getByRole("button", { name: `Open task: ${data.tasks[0]!.title}` }).click();
    const save = await style(page, "Save");
    expect(save.opacity).toBe("1");
    expect(save.background).toBe("rgb(234, 228, 216)");
    expect(save.color).toBe("rgb(83, 99, 106)");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect.poll(async () => (await style(page, "Cancel")).shadow).toContain("rgb(46, 111, 115)");
  });

  test("loading keeps the action's width and context, and announces it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, recordUrl("Tasks", data.tasks[1]!.id));
    await page.getByLabel("Task title").fill(`${data.tasks[1]!.title} (edited)`);
    const save = page.getByRole("button", { name: "Save" });
    const before = (await save.boundingBox())!.width;
    let release!: () => void;
    await page.route("**/api/v1/**", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      await new Promise<void>((resolve) => { release = resolve; });
      await route.continue();
    });
    await save.click();
    const busy = page.locator("button[aria-busy='true']");
    await expect(busy).toHaveText("Saving…");
    expect(Math.abs((await busy.boundingBox())!.width - before)).toBeLessThanOrEqual(1);
    await expect(page.locator(".sticky-record-actions [role='status']")).toHaveText("Saving…");
    release();
    await expect(page.locator(".sticky-record-actions [role='status']")).toHaveText("Saved");
  });

  test("final destructive confirmation uses the solid error treatment", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/notes");
    const colours = await page.evaluate(() => {
      const routine = document.createElement("button"); routine.className = "danger"; routine.textContent = "Delete";
      const final = document.createElement("button"); final.className = "danger-confirm"; final.textContent = "Delete permanently";
      document.querySelector(".shell-canvas")!.append(routine, final);
      const read = (element: Element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color });
      return { routine: read(routine), final: read(final) };
    });
    expect(colours.routine.background).toBe("rgb(255, 255, 255)");
    expect(colours.final).toEqual({ background: "rgb(104, 31, 40)", color: "rgb(255, 255, 255)" });
  });

  test("reduced motion removes non-essential movement", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/tasks");
    const primary = page.getByRole("button", { name: "New Task" });
    expect(parseFloat(await primary.evaluate((element) => getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
    await primary.hover();
    await expect.poll(async () => (await style(page, "New Task")).transform).toBe("none");
  });
});

test.describe("workspace-specific reflow", () => {
  test("Today never stretches Top 3; narrow puts priorities first; wide uses three purposeful columns", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, "/");
    const top3 = (await page.locator(".today-top3").boundingBox())!;
    const card = (await page.locator(".today-top3 > article").boundingBox())!;
    expect(Math.abs(top3.height - card.height)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 800 });
    const narrow = await Promise.all([".today-top3", ".today-next-meeting", ".quick-capture", ".today-context"].map(async (selector) => (await page.locator(selector).first().boundingBox())!.y));
    expect([...narrow].sort((a, b) => a - b)).toEqual(narrow);
    await page.setViewportSize({ width: 2560, height: 1440 });
    const columns = await Promise.all([".today-top3", ".today-side-rail", ".today-context"].map(async (selector) => (await page.locator(selector).boundingBox())!));
    expect(columns[0]!.x).toBeLessThan(columns[1]!.x);
    expect(columns[1]!.x).toBeLessThan(columns[2]!.x);
    expect(Math.abs(columns[0]!.y - columns[2]!.y)).toBeLessThanOrEqual(1);
  });

  test("Inbox evidence becomes an internal rail only on wide screens", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await open(page, recordUrl("Inbox", data.reviewItems[0]!.id));
    const rail = (await page.getByRole("group", { name: "Source and evidence" }).boundingBox())!;
    const actions = (await page.locator(".inbox-decision-actions").boundingBox())!;
    expect(rail.x).toBeGreaterThan(actions.x + actions.width - 1);
    await page.setViewportSize({ width: 1280, height: 800 });
    const stacked = (await page.getByRole("group", { name: "Source and evidence" }).boundingBox())!;
    expect(stacked.y).toBeLessThan((await page.locator(".inbox-decision-actions").boundingBox())!.y);
  });

  test("Decisions relationships and Knowledge sources sit beside the record only on wide screens", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await open(page, recordUrl("Decisions", data.decisions[0]!.id));
    const heading = (await page.locator(".decision-heading").boundingBox())!;
    const links = (await page.locator(".decision-links").boundingBox())!;
    expect(links.x).toBeGreaterThan(heading.x + 400);
    await open(page, recordUrl("Knowledge", data.longKnowledgeNote.id));
    const reader = (await page.locator(".knowledge-markdown").boundingBox())!;
    const sources = (await page.getByLabel("Sources", { exact: true }).boundingBox())!;
    expect(sources.x).toBeGreaterThan(reader.x + reader.width - 1);
  });

  test("Reference data nests list and detail only when both fit", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await open(page, "/settings");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    const list = page.getByLabel("Projects list", { exact: true });
    await expect(list).toBeVisible();
    await expect(page.getByRole("region", { name: "project details" })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("region", { name: "project details" })).toBeHidden();
    await page.getByRole("button", { name: `Open project: ${data.projects[0]!.title}` }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole("heading", { name: data.projects[0]!.title })).toBeFocused();
  });
});
