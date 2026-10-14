import { expect, test, type APIRequestContext } from "@playwright/test";
import { uuidV7 } from "../../apps/web/src/uuid.js";
import { seed } from "./fixtures.js";

// PB-034 (#222): "New note" writes nothing until the first real edit. Real local API, synthetic data from serve.mjs.
const standaloneNotes = async (request: APIRequestContext) => {
  const response = await request.get("/api/v1/notes?type=standalone-note");
  return (await response.json()) as Array<{ frontmatter: Record<string, unknown> & { id: string; title: string; origin: string }; relativePath: string; body: string }>;
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

// PB-034 (#223): the header works before the file exists; setting a field is itself the first real edit.
type Created = { frontmatter: Record<string, unknown> & { id: string; title: string }; relativePath: string; body: string };
const entity = async (request: APIRequestContext, type: "client" | "product", title: string) => {
  const response = await request.post(`/api/v1/entities/${type}`, { data: { fields: { title } } });
  return ((await response.json()) as Created).frontmatter.id;
};
const pickOption = async (page: import("@playwright/test").Page, label: string, option: string) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option }).first().click();
};

test("Header choices before any body text create the note with all of them", async ({ page, request }) => {
  const data = await seed(request);
  const clientId = await entity(request, "client", "Header Client");
  const productId = await entity(request, "product", "Header Product");
  await page.goto("/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("button", { name: "Copy link" })).toHaveCount(0);

  await page.getByTitle("Click to rename").click();
  await page.getByLabel("Note title").fill("Header first title");
  await page.getByLabel("Note title").press("Enter");
  await expect.poll(async () => (await standaloneNotes(request)).some((note) => note.frontmatter.title === "Header first title"), { timeout: 10_000 }).toBe(true);
  const created = (await standaloneNotes(request)).find((note) => note.frontmatter.title === "Header first title")!;
  await expect(page).toHaveURL(new RegExp(`/notes/${created.frontmatter.id}$`));
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();

  // After the save the same header keeps working: all links, two people and Restricted.
  await pickOption(page, "Project", data.projects[0]!.title);
  await pickOption(page, "Client", "Header Client");
  await pickOption(page, "Product", "Header Product");
  await pickOption(page, "People", "Alex");
  await pickOption(page, "People", "Sam");
  await page.getByLabel("Mark restricted").check();
  await expect.poll(async () => {
    const note = (await standaloneNotes(request)).find((candidate) => candidate.frontmatter.id === created.frontmatter.id)!;
    return [note.frontmatter.primary_project_id, note.frontmatter.primary_client_id, note.frontmatter.primary_product_id, (note.frontmatter.people_ids as string[]).length, note.frontmatter.sensitivity];
  }, { timeout: 10_000 }).toEqual([data.projects[0]!.id, clientId, productId, 2, "restricted"]);
});

test("A failed first save keeps the held choices on screen with the error", async ({ page, request }) => {
  await seed(request);
  const before = await standaloneNotes(request);
  await page.route("**/api/v1/notes", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Disk is full (synthetic)" }) });
    else await route.continue();
  });
  await page.goto("/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Mark restricted").check();
  await expect(page.getByText(/could not be created yet/)).toBeVisible();
  await expect(page.getByLabel("Mark restricted")).toBeChecked();
  expect(await standaloneNotes(request)).toEqual(before);

  // Network back: the next edit creates the note with the choice that was held.
  await page.unroute("**/api/v1/notes");
  await page.getByRole("button", { name: "Markdown" }).click();
  await page.getByPlaceholder("Write Markdown…").fill("Recovered after failure");
  await expect.poll(async () => (await standaloneNotes(request)).find((note) => note.body === "Recovered after failure")?.frontmatter.sensitivity, { timeout: 10_000 }).toBe("restricted");
});

// PB-034 (#224): a Standalone Note is found by global search and opened by a lifeos:// link.
const createNote = async (request: APIRequestContext, title: string, body: string) => {
  const response = await request.post("/api/v1/notes", { data: { id: uuidV7(), title, body } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as Created).frontmatter.id;
};

test("Global search finds a Standalone Note by its title and by a word in its body", async ({ page, request }) => {
  await seed(request);
  const id = await createNote(request, "Zebrafinch planning", "Remember the quokkawombat idea.");
  await page.goto("/tasks");
  await page.getByRole("complementary", { name: "Application navigation" }).getByRole("button", { name: "Search" }).click();
  const search = page.getByLabel("Search LifeOS");
  for (const query of ["Zebrafinch", "quokkawombat"]) {
    await search.fill(query);
    await page.getByRole("button", { name: /Zebrafinch planning/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
    await page.getByRole("complementary", { name: "Application navigation" }).getByRole("button", { name: "Search" }).click();
  }
});

test("A lifeos:// link in another note opens the Standalone Note", async ({ page, request }) => {
  await seed(request);
  const target = await createNote(request, "Linked target note", "Target body");
  const source = await createNote(request, "Linking note", `See [the target](lifeos://object/${target}) now.`);
  await page.goto(`/notes/${source}`);
  await page.getByRole("link", { name: "the target" }).dispatchEvent("click");
  await expect(page).toHaveURL(new RegExp(`/notes/${target}$`));
  await expect(page.getByRole("button", { name: "Open note: Linked target note" })).toBeVisible();
});
