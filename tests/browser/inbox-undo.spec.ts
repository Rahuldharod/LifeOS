import { expect, test, type APIRequestContext } from "@playwright/test";
import { UNDO_PREFIX, seed } from "./fixtures.js";

// #241 (ADR 0025): the toast after a Review action offers Undo (and Z) and View; one Undo covers a bulk batch.
// Real local API, synthetic proposals from serve.mjs.
type Listed = { frontmatter: { id: string; type: string; title: string; deleted_at?: string; revision: number }; contentHash: string };
const listed = async (request: APIRequestContext) => (await (await request.get("/api/v1/objects")).json()) as Listed[];
const taskTitled = async (request: APIRequestContext, title: string) => (await listed(request)).find((object) => object.frontmatter.type === "task" && object.frontmatter.title === title && !object.frontmatter.deleted_at);

test("toast Undo, Z and View; bulk Reject needs no confirmation and undoes as one; an edited object refuses the undo", async ({ page, request }) => {
  await seed(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  let dialogs = 0;
  page.on("dialog", (dialog) => { dialogs += 1; void dialog.dismiss(); });
  await page.goto("/inbox");
  await page.getByLabel("Search proposals").fill(UNDO_PREFIX);
  await page.keyboard.press("Escape");
  const queue = page.getByRole("region", { name: "Review queue" });
  const rows = queue.locator(".inbox-row:not(.inbox-colhead)");
  await expect(rows).toHaveCount(4);
  const toast = page.locator(".inbox-toast");
  const titleOf = async (index: number) => (await rows.nth(index).locator(".inbox-row-open strong").textContent())!;
  const focused = queue.locator(".inbox-row.focused");
  const [one, two] = [await titleOf(0), await titleOf(1)];

  // Reject, then the toast's Undo: the item is back and is the Focused item.
  await rows.nth(0).locator(".inbox-row-open").click();
  await page.keyboard.press("r");
  await expect(rows).toHaveCount(3);
  await expect(toast).toContainText("Proposal rejected");
  await expect(toast.getByRole("button", { name: /^View/ })).toHaveCount(0); // a reject has nothing to open
  await toast.getByRole("button", { name: /^Undo/ }).click();
  await expect(rows).toHaveCount(4);
  await expect(toast).toContainText("1 proposal back in the Inbox");
  await expect(focused).toContainText(one);

  // Accept creates the task; Z undoes it: back to pending, the task it created is deleted.
  await page.keyboard.press("a");
  await expect(rows).toHaveCount(3);
  await expect(toast.getByRole("button", { name: /^View/ })).toBeVisible();
  const created = await taskTitled(request, one);
  expect(created?.frontmatter.deleted_at).toBeUndefined();
  await page.keyboard.press("z");
  await expect(rows).toHaveCount(4);
  await expect(focused).toContainText(one);
  await expect.poll(async () => (await listed(request)).find((object) => object.frontmatter.id === created!.frontmatter.id)?.frontmatter.deleted_at).toBeTruthy();

  // Bulk Reject: no confirmation, one Undo for the whole batch.
  await queue.getByLabel(`Select proposal: ${one}`).check();
  await queue.getByLabel(`Select proposal: ${two}`).check();
  await page.getByRole("button", { name: "Reject selected (2)" }).click();
  await expect(rows).toHaveCount(2);
  await expect(toast).toContainText("2 proposals rejected");
  expect(dialogs).toBe(0);
  await toast.getByRole("button", { name: /^Undo/ }).click();
  await expect(rows).toHaveCount(4);
  await expect(toast).toContainText("2 proposals back in the Inbox");

  // Accept, edit what it created, then Undo is refused with the reason and a way to open the object.
  await queue.locator(".inbox-row-open", { hasText: one }).click();
  await page.keyboard.press("a");
  await expect(rows).toHaveCount(3);
  const accepted = (await taskTitled(request, one))!;
  const edit = await request.fetch(`/api/v1/entities/by-id/${accepted.frontmatter.id}`, { method: "PATCH", data: { fields: { priority: "High" }, expectedHash: accepted.contentHash } });
  expect(edit.ok()).toBe(true);
  await page.keyboard.press("z");
  await expect(toast).toContainText("was changed after it was accepted");
  await expect(rows).toHaveCount(3);
  await toast.getByRole("button", { name: /^View/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${accepted.frontmatter.id}`));
  expect((await taskTitled(request, one))?.frontmatter.deleted_at).toBeUndefined();
});
