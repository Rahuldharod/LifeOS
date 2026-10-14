import { expect, test, type APIRequestContext } from "@playwright/test";
import { seed } from "./fixtures.js";

// #183 follow-up: typing at the end of a Visual Note whose last line ends in an HTML comment must reach the file,
// and the comment must stay. Plain single (non-recurring) meetings from serve.mjs, Visual mode (the default).
//
// Control+End does not go to the end of the document on macOS (it goes to the start, so the text lands before the
// heading: "# TYPEDSolo heading"). This was first mistaken for a lost keystroke; it is a test artifact. The platform's
// own "end of document" key is used here.
const END_OF_DOCUMENT = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

const solo = (month: string) => ({ meeting: `61000000-0000-4000-8000-0000000000${month}`, note: `62000000-0000-4000-8000-0000000000${month}` });
const note = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/v1/notes/${id}`)).json()) as { body: string; contentHash: string };
const noteBody = async (request: APIRequestContext, id: string) => (await note(request, id)).body;

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("typing at the end of a Note ending in an HTML comment is saved and the comment kept", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-05-12/${solo("04").meeting}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo heading" })).toBeVisible();
  await editor.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  await page.keyboard.type(" typed at the end");
  await expect.poll(() => noteBody(request, solo("04").note), { timeout: 15000 }).toContain("typed at the end");
  const body = await noteBody(request, solo("04").note);
  expect(body).toContain("<!-- keep me -->");
  expect(body.startsWith("# Solo heading\n")).toBe(true);
});

test("typing at the end of a Note ending in an app summary marker is saved and the marker kept", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-05-12/${solo("05").meeting}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo summary" })).toBeVisible();
  await editor.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  await page.keyboard.type(" typed at the end");
  await expect.poll(() => noteBody(request, solo("05").note), { timeout: 15000 }).toContain("typed at the end");
  expect(await noteBody(request, solo("05").note)).toContain("<!-- lifeos:summary:end -->");
});

test("an image in a Note shows in Visual and survives an edit round trip", async ({ page, request }) => {
  await seed(request);
  const { meeting, note: noteId } = solo("06");
  const stored = (await (await request.post(`/api/v1/objects/${noteId}/assets`, { data: { fileName: "synthetic-dot.png", mimeType: "image/png", contentBase64: PNG } })).json()) as { markdownPath: string };
  const image = `![synthetic dot](${stored.markdownPath})`;
  const { body, contentHash } = await note(request, noteId);
  expect((await request.put(`/api/v1/objects/${noteId}/body`, { data: { body: `${body}\n${image}\n`, expectedHash: contentHash } })).ok()).toBeTruthy();

  await page.goto(`/calendar/2026-05-12/${meeting}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.locator("img")).toBeVisible();
  await expect.poll(() => editor.locator("img").evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await editor.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited.");
  await expect.poll(() => noteBody(request, noteId), { timeout: 15000 }).toContain("Edited.");
  const saved = await noteBody(request, noteId);
  expect(saved).toContain(image);
  expect(saved.match(/!\[/g)).toHaveLength(1);
});

test("one keystroke followed at once by the switch to Markdown is not lost", async ({ page, request }) => {
  await seed(request);
  await page.goto(`/calendar/2026-05-12/${solo("04").meeting}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo heading" })).toBeVisible();
  await editor.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  await page.keyboard.type("Q");
  // No wait: the editor reports changes after a short delay, so only closing the editor can carry this keystroke.
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.getByPlaceholder("Capture meeting notes")).toHaveValue(/Last line .*Q/);
});

test("focusing a Note the Visual editor would re-format and switching mode without typing does not rewrite the file", async ({ page, request }) => {
  await seed(request);
  const before = await noteBody(request, solo("07").note);
  const writes: string[] = [];
  page.on("request", (call) => { if (call.method() !== "GET" && /\/api\/v1\/objects\/[^/]+\/body/.test(call.url())) writes.push(call.url()); });
  await page.goto(`/calendar/2026-05-12/${solo("07").meeting}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo normal" })).toBeVisible();
  await editor.focus();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.getByPlaceholder("Capture meeting notes")).toHaveValue(before);
  await page.waitForTimeout(3500); // longer than the 1.8 s autosave
  expect(writes).toEqual([]);
  expect(await noteBody(request, solo("07").note)).toBe(before);
});

test("typing in one Note and switching to another in the Notes list leaves the other Note untouched", async ({ page, request }) => {
  await seed(request);
  const other = await noteBody(request, solo("05").note);
  await page.goto(`/notes/${solo("04").note}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo heading" })).toBeVisible();
  await editor.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  await page.keyboard.type("Q");
  await page.getByText("Solo notes 05", { exact: true }).first().click();
  await expect(page.locator("[contenteditable='true']").first().getByRole("heading", { name: "Solo summary" })).toBeVisible();
  await page.waitForTimeout(3500);
  expect(await noteBody(request, solo("05").note)).toBe(other);
  await expect(page.locator("[contenteditable='true']").first()).not.toContainText("Q");
});

// #192: the editor reports typing after a short debounce. The page clock is paused while typing and switching, so that
// debounce cannot fire before the switch: only the editor's own flush can carry the typing to the original Note.
test("typing in Visual and opening another Note at once saves the typing to the original Note, never the next", async ({ page, request }) => {
  await seed(request);
  const other = await noteBody(request, solo("05").note);
  await page.clock.install();
  await page.goto(`/notes/${solo("04").note}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo heading" })).toBeVisible();
  await editor.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.type("Z192");
  await page.getByText("Solo notes 05", { exact: true }).first().click();
  await expect(page.locator("[contenteditable='true']").first().getByRole("heading", { name: "Solo summary" })).toBeVisible();
  await expect(page.locator("[contenteditable='true']").first()).not.toContainText("Z192");
  await page.clock.resume();
  await expect.poll(() => noteBody(request, solo("04").note), { timeout: 15000 }).toContain("Z192");
  await page.clock.runFor(5000); // well past the editor debounce and the 1.8 s autosave
  expect(await noteBody(request, solo("05").note)).toBe(other);
});

test("opening another Note without typing writes nothing, even for a Note the Visual editor would re-format", async ({ page, request }) => {
  await seed(request);
  const before = await noteBody(request, solo("07").note);
  const writes: string[] = [];
  page.on("request", (call) => { if (call.method() !== "GET" && /\/api\/v1\/objects\/[^/]+\/body/.test(call.url())) writes.push(call.url()); });
  await page.clock.install();
  await page.goto(`/notes/${solo("07").note}`);
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo normal" })).toBeVisible();
  await editor.focus();
  await page.getByText("Solo notes 05", { exact: true }).first().click();
  await expect(page.locator("[contenteditable='true']").first().getByRole("heading", { name: "Solo summary" })).toBeVisible();
  await page.clock.runFor(5000);
  expect(writes).toEqual([]);
  expect(await noteBody(request, solo("07").note)).toBe(before);
});

// #192 review: a switch that does not move focus (Back / Forward, a programmatic open) gives the editor no blur to
// flush on. The typing must still reach the Note it was typed in, never the next one. The clock is paused as above.
test("typing in Visual and going Back to another Note without leaving the editor saves the typing to the original Note", async ({ page, request }) => {
  await seed(request);
  const other = await noteBody(request, solo("05").note);
  await page.clock.install();
  await page.goto(`/notes/${solo("05").note}`);
  await page.getByText("Solo notes 06", { exact: true }).first().click();
  const editor = page.locator("[contenteditable='true']").first();
  await expect(editor.getByRole("heading", { name: "Solo image" })).toBeVisible();
  await editor.focus();
  await page.keyboard.press(END_OF_DOCUMENT);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.type("Z192B");
  await page.goBack();
  await expect(page.locator("[contenteditable='true']").first().getByRole("heading", { name: "Solo summary" })).toBeVisible();
  await expect(page.locator("[contenteditable='true']").first()).not.toContainText("Z192B");
  await page.clock.resume();
  await expect.poll(() => noteBody(request, solo("06").note), { timeout: 15000 }).toContain("Z192B");
  await page.clock.runFor(5000); // well past the editor debounce and the 1.8 s autosave
  expect(await noteBody(request, solo("05").note)).toBe(other);
});
