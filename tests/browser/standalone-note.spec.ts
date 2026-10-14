import { expect, test, type APIRequestContext } from "@playwright/test";
import { seed } from "./fixtures.js";

// PB-034 (#222): "New note" writes nothing until the first real edit. Real local API, synthetic data from serve.mjs.
const standaloneNotes = async (request: APIRequestContext) => {
  const response = await request.get("/api/v1/notes?type=standalone-note");
  return (await response.json()) as Array<{ frontmatter: { id: string; title: string; origin: string }; relativePath: string; body: string }>;
};

test("New note and leaving without typing writes nothing", async ({ page, request }) => {
  await seed(request);
  const before = await standaloneNotes(request);
  await page.goto("/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeVisible();
  await page.getByRole("tab", { name: /^Deleted/ }).click();
  await expect(page).toHaveURL(/\/notes\/deleted/);
  await page.getByRole("tab", { name: /^Open/ }).click();
  await page.goto("/tasks");
  await page.waitForTimeout(2500);
  expect(await standaloneNotes(request)).toEqual(before);
});

test("New note then typing creates one note in the Notes list, and later edits go to the same file", async ({ page, request }) => {
  await seed(request);
  const before = await standaloneNotes(request);
  await page.goto("/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("button", { name: "Markdown" }).click();
  await page.getByPlaceholder("Write Markdown…").fill("Browser standalone first words");

  await expect.poll(async () => (await standaloneNotes(request)).length, { timeout: 10_000 }).toBe(before.length + 1);
  const created = (await standaloneNotes(request)).find((note) => note.body === "Browser standalone first words")!;
  expect(created.frontmatter.origin).toBe("app");
  expect(created.frontmatter.title).toMatch(/^Note \d{1,2} \w{3} \d{4} \d{2}:\d{2}$/);
  expect(created.relativePath).toMatch(/^notes\//);
  await expect(page).toHaveURL(new RegExp(`/notes/${created.frontmatter.id}$`));
  await expect(page.getByRole("button", { name: `Open note: ${created.frontmatter.title}` })).toBeVisible();

  await page.getByPlaceholder("Write Markdown…").fill("Browser standalone first words and more");
  await expect.poll(async () => (await standaloneNotes(request)).find((note) => note.frontmatter.id === created.frontmatter.id)?.body, { timeout: 10_000 }).toBe("Browser standalone first words and more");
  const after = (await standaloneNotes(request)).filter((note) => note.frontmatter.id === created.frontmatter.id);
  expect(after).toHaveLength(1);
  expect(after[0]!.relativePath).toBe(created.relativePath);
  expect(await standaloneNotes(request)).toHaveLength(before.length + 1);
});
