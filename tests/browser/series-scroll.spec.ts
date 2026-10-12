import { expect, test } from "@playwright/test";
import { seed } from "./fixtures.js";

// #184: collapse, scroll within a Note, and jump across Notes. Real local API; "scroll" series from serve.mjs
// (Jan, Feb with a very long Note, Mar opened).
const MARCH = "61000000-0000-4000-8000-000000000003";
const OPENED = `/calendar/2026-03-10/${MARCH}`;
const WIDTHS = [["desktop", 1280], ["phone", 390]] as const;
const noSideScroll = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const [label, width] of WIDTHS) {
  test(`an occurrence opens, closes and re-opens by click and by keyboard at ${label} width`, async ({ page, request }) => {
    await seed(request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(OPENED);
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    const february = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(0);
    const summary = february.locator("summary");
    await expect(february).not.toHaveAttribute("open", "");
    await summary.click();
    await expect(february).toHaveAttribute("open", "");
    await summary.click();
    await expect(february).not.toHaveAttribute("open", "");
    await summary.click();
    await expect(february).toHaveAttribute("open", "");
    // Keyboard: Enter closes, Space opens.
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(february).not.toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(february).toHaveAttribute("open", "");
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  });
}

test("closing an occurrence keeps unsaved typing and triggers no save", async ({ page, request }) => {
  await seed(request);
  await page.goto(OPENED);
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const january = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(1);
  await january.locator("summary").click();
  // Block the save so the text stays a browser draft only; count save attempts.
  let saves = 0;
  await page.route("**/api/v1/objects/*/body", (route) => { saves += 1; return route.abort(); });
  await january.locator("textarea").fill("Unsaved January typing.\n");
  await expect.poll(() => saves, { timeout: 8000 }).toBeGreaterThan(0); // the autosave fired on its own
  const before = saves;
  await january.locator("summary").click(); // close
  await january.locator("summary").click(); // re-open
  await expect(january.locator("textarea")).toHaveValue("Unsaved January typing.\n");
  await page.waitForTimeout(500);
  expect(saves).toBe(before);
});

for (const [label, width] of WIDTHS) {
  test(`a long Note scrolls inside its own Markdown editor with a visible scrollbar and the caret stays in view at ${label} width`, async ({ page, request }) => {
    await seed(request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(OPENED);
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    const february = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(0);
    await february.locator("summary").click();
    const area = february.locator("textarea");
    const m = await area.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflowY: getComputedStyle(el).overflowY, gutter: getComputedStyle(el).scrollbarGutter, color: getComputedStyle(el).scrollbarColor }));
    expect(m.scroll).toBeGreaterThan(m.client);
    expect(["auto", "scroll"]).toContain(m.overflowY);
    expect(m.client).toBeLessThan(700);
    // Headless Chromium hides scrollbars, so assert the CSS that keeps them visible on macOS: a reserved gutter and a coloured track.
    expect(m.gutter).toBe("stable");
    expect(m.color).not.toBe("auto");
    await area.click();
    await area.evaluate((el) => { const box = el as HTMLTextAreaElement; box.setSelectionRange(box.value.length, box.value.length); }); // caret at the end, on any OS
    await page.keyboard.type("Typed at the very end.");
    expect(await area.evaluate((el) => (el as HTMLTextAreaElement).selectionStart === (el as HTMLTextAreaElement).value.length)).toBe(true);
    expect(await area.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 40)).toBe(true);
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  });

  test(`a long Note in Visual mode scrolls inside its own area, keeps its toolbar in reach and the caret in view at ${label} width`, async ({ page, request }) => {
    await seed(request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(OPENED); // Visual is the default mode
    const february = page.getByRole("region", { name: "Earlier occurrences" }).locator("details").nth(0);
    await february.locator("summary").click();
    const wrapper = february.locator(".visual-markdown-editor");
    const content = wrapper.locator(".ProseMirror");
    await expect(content).toContainText("scroll line 80 of a very long Note.");
    const m = await wrapper.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflowY: getComputedStyle(el).overflowY, gutter: getComputedStyle(el).scrollbarGutter, color: getComputedStyle(el).scrollbarColor }));
    expect(m.scroll).toBeGreaterThan(m.client);
    expect(["auto", "scroll"]).toContain(m.overflowY);
    expect(m.client).toBeLessThan(700);
    // Headless Chromium hides scrollbars, so assert the CSS that keeps them visible on macOS: a reserved gutter and a coloured track.
    expect(m.gutter).toBe("stable");
    expect(m.color).not.toBe("auto");
    await content.click();
    await content.evaluate((el) => { const selection = window.getSelection()!; selection.selectAllChildren(el); selection.collapseToEnd(); });
    await page.keyboard.type(" Typed at the very end.");
    await expect(content).toContainText("Typed at the very end.");
    const geometry = await wrapper.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const caret = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const bar = el.querySelector(".milkdown-top-bar")?.getBoundingClientRect();
      return { scrolled: el.scrollTop, boxTop: box.top, boxBottom: box.bottom, caretBottom: caret.bottom, caretTop: caret.top, barTop: bar?.top ?? Number.NaN, barBottom: bar?.bottom ?? Number.NaN };
    });
    expect(geometry.scrolled).toBeGreaterThan(0);
    expect(geometry.caretBottom).toBeLessThanOrEqual(geometry.boxBottom + 1);
    expect(geometry.caretTop).toBeGreaterThanOrEqual(geometry.boxTop);
    // The toolbar is still pinned at the top of the scrolling area, and below it sits the text, not over the caret.
    expect(Math.abs(geometry.barTop - geometry.boxTop)).toBeLessThanOrEqual(2);
    expect(geometry.caretTop).toBeGreaterThanOrEqual(geometry.barBottom - 1);
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  });

  test(`the date list jumps to an occurrence: opens it and scrolls it into view, including Load older entries, at ${label} width`, async ({ page, request }) => {
    await seed(request);
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/calendar/2026-04-20/e1000000-0000-4000-8000-000000000008");
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    const series = page.getByRole("region", { name: "Earlier occurrences" });
    const dates = series.getByRole("navigation", { name: "Jump to an occurrence" });
    await series.getByRole("button", { name: "Load older" }).click();
    const loaded = series.locator("details").nth(6);
    await expect(loaded.locator("summary")).toContainText("March 2, 2026");
    await expect(loaded).not.toHaveAttribute("open", "");
    await dates.getByRole("button", { name: /March 2, 2026/ }).click();
    await expect(loaded).toHaveAttribute("open", "");
    await expect(loaded.locator("summary")).toBeInViewport();
    // Jumping to one that is already open keeps it open.
    await dates.getByRole("button", { name: /March 2, 2026/ }).click();
    await expect(loaded).toHaveAttribute("open", "");
    expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  });
}
