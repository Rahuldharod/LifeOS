import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { objectTypes, uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #47 (ADR 0011, PRD "Daily Focus and Today"): the user's pin, replace and dismiss choices on the
// Top 3 live in one app-owned `focus-override` object per date, applied on top of the brief or the rule.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const now = new Date("2026-10-05T12:00:00.000Z");
const date = "2026-10-05";
const overridePath = (root: string, day = date) => path.join(root, "focus-overrides", `${day}.md`);

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-override-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify(fields)}---\nMorning.\n`);
  const past = new Date(now.getTime() - 60_000); // relative to the test clock, so the draft is never "still being written" whatever the real date
  await utimes(target, past, past);
}
const brief = (top3: string[], overrides: Record<string, unknown> = {}) => ({
  lifeos_draft: 1, kind: "daily-focus", draft_key: "focus-0600", origin: "agent-extracted", title: "Daily Focus 2026-10-05",
  captured_at: "2026-10-05T06:00:00+02:00", focus_on: date, generated_at: "2026-10-05T06:00:00+02:00",
  top3: top3.map((task_id, index) => ({ task_id, why_today: `why ${index + 1}` })), ...overrides
});
async function adoptBrief(root: string, application: LifeOSApplication, top3: string[], overrides: Record<string, unknown> = {}, name = "focus.md") {
  await dropDraft(root, name, brief(top3, overrides));
  const batch = await application.adoptDrafts({ now });
  expect(batch.drafts.map((draft) => draft.outcome)).toEqual(["adopted"]);
}
const task = (application: LifeOSApplication, title: string, fields: Record<string, unknown> = {}) => application.createEntity("task", { title, ...fields }).then((object) => object.frontmatter.id);
const tasks = (application: LifeOSApplication, ...titles: string[]) => Promise.all(titles.map((title) => task(application, title)));
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const focusOf = (application: LifeOSApplication) => application.today({ date, now }).focus;
const top3Ids = (application: LifeOSApplication) => focusOf(application).top3.map((item) => item.id);
const hashOf = (application: LifeOSApplication) => focusOf(application).override?.contentHash;
/** One override change with the current hash, as the Today page sends it. */
const change = (application: LifeOSApplication, action: string, taskId?: string, replacementId?: string, day = date) =>
  application.overrideFocus(day, { action, taskId, replacementId }, day === date ? hashOf(application) : application.today({ date: day, now }).focus.override?.contentHash, { now });

describe("the focus-override object", () => {
  it("is a new app-owned type, one fixed-path file per date holding pinned, replaced and dismissed task IDs", async () => {
    expect(objectTypes).toContain("focus-override");
    const { root, application } = await vault();
    const [a, b, c, d] = await tasks(application, "A", "B", "C", "D");
    await adoptBrief(root, application, [a!, b!]);

    await change(application, "pin", c);
    await change(application, "replace", b, d);
    await change(application, "dismiss", a);

    expect(await readdir(path.join(root, "focus-overrides"))).toEqual([`${date}.md`]);
    const frontmatter = await frontmatterOf(overridePath(root));
    expect(frontmatter).toMatchObject({ type: "focus-override", origin: "app", focus_on: date, revision: 3, pinned: [c], replaced: [{ from: b, to: d }], dismissed: [a] });
    const view = focusOf(application);
    expect(view.override).toMatchObject({ id: frontmatter.id, path: `focus-overrides/${date}.md`, pinned: [c], replaced: [{ from: b, to: d }], dismissed: [a] });
    expect(view.top3.map((item) => item.id)).toEqual([c, d]);
  });

  it("keeps each date separate", async () => {
    const { application } = await vault();
    const [a, b] = await tasks(application, "A", "B");
    await change(application, "dismiss", a);
    await change(application, "dismiss", b, undefined, "2026-10-06");
    expect(focusOf(application).override!.dismissed).toEqual([a]);
    expect(application.today({ date: "2026-10-06", now }).focus.override!.dismissed).toEqual([b]);
  });

  it("is a guarded save: a stale hash or a missing hash on an existing override is a conflict, and nothing is written", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "C");
    await adoptBrief(root, application, [a!, b!]);
    const first = await application.overrideFocus(date, { action: "pin", taskId: c }, undefined, { now });
    const stale = (await frontmatterOf(overridePath(root))).id;
    await application.overrideFocus(date, { action: "dismiss", taskId: a }, first.override!.contentHash, { now });
    const before = await readFile(overridePath(root), "utf8");

    // Another device saved in between: the first hash is stale.
    await expect(application.overrideFocus(date, { action: "dismiss", taskId: b }, first.override!.contentHash, { now })).rejects.toMatchObject({ name: "ObjectConflictError" });
    // A device that never saw the file tries to create it again.
    await expect(application.overrideFocus(date, { action: "dismiss", taskId: b }, undefined, { now })).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect(await readFile(overridePath(root), "utf8")).toBe(before);
    expect((await frontmatterOf(overridePath(root))).id).toBe(stale);
  });

  it("is a conflict when a hash is sent but the override was removed", async () => {
    const { root, application } = await vault();
    const [a] = await tasks(application, "A");
    const view = await change(application, "dismiss", a);
    await rm(overridePath(root));
    await application.rebuildIndex();
    await expect(application.overrideFocus(date, { action: "restore", taskId: a }, view.override!.contentHash, { now })).rejects.toMatchObject({ name: "ObjectConflictError" });
  });
});

describe("pin", () => {
  it("adds a task to the Top 3 when there is room, first, with a visible reason", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "C");
    await adoptBrief(root, application, [a!, b!]);
    const view = await change(application, "pin", c);
    expect(view.top3Source).toBe("brief");
    expect(view.top3.map((item) => [item.id, item.pinned ?? false, item.whyToday])).toEqual([[c, true, "Pinned by you"], [a, false, "why 1"], [b, false, "why 2"]]);
  });

  it("moves a brief item to the front and keeps its why-today", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "C");
    await adoptBrief(root, application, [a!, b!, c!]);
    await change(application, "pin", c);
    expect(focusOf(application).top3.map((item) => [item.id, item.whyToday])).toEqual([[c, "why 3"], [a, "why 1"], [b, "why 2"]]);
  });

  it("is refused when the Top 3 is full, and pinning twice is a no-op", async () => {
    const { root, application } = await vault();
    const [a, b, c, d] = await tasks(application, "A", "B", "C", "D");
    await adoptBrief(root, application, [a!, b!, c!]);
    await expect(change(application, "pin", d)).rejects.toThrow("The Top 3 is full (3 must-dos): dismiss or replace one first");
    await change(application, "pin", a);
    const hash = hashOf(application);
    await change(application, "pin", a);
    expect(hashOf(application)).toBe(hash);
    expect((await frontmatterOf(overridePath(root))).pinned).toEqual([a]);
  });

  it("refuses restricted, unknown, deleted and non-task targets", async () => {
    const { application } = await vault();
    const [secret, gone] = await tasks(application, "Private", "Gone");
    await application.setSensitivity(secret!, "restricted", application.object(secret!).contentHash);
    await application.deleteEntity(gone!, application.object(gone!).contentHash);
    const person = (await application.createEntity("person", { title: "Joel", given_name: "Joel" })).frontmatter.id;
    await expect(change(application, "pin", secret)).rejects.toThrow("Restricted tasks never appear in the Top 3");
    await expect(change(application, "pin", uuidV7())).rejects.toThrow("Task not found");
    await expect(change(application, "pin", gone)).rejects.toThrow("Task not found");
    await expect(change(application, "pin", person)).rejects.toThrow("Task not found");
    await expect(change(application, "pin", "not-an-id")).rejects.toThrow("taskId: not an object ID");
  });

  it("unpin returns the task to where the brief or rule puts it", async () => {
    const { application } = await vault();
    const high = await task(application, "High", { priority: "High" });
    const low = await task(application, "Low", { priority: "Low" });
    await change(application, "pin", low);
    expect(top3Ids(application)).toEqual([low, high]);
    await change(application, "unpin", low);
    expect(top3Ids(application)).toEqual([high, low]);
  });

  it("a pinned task that is finished stays, struck through and sunk; a deleted one drops out", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "C");
    await adoptBrief(root, application, [a!]);
    await change(application, "pin", b);
    await change(application, "pin", c);
    await application.updateTask(b!, { status: "Done" }, application.object(b!).contentHash);
    await application.deleteEntity(c!, application.object(c!).contentHash);
    expect(focusOf(application).top3.map((item) => [item.id, item.state])).toEqual([[a, "open"], [b, "done"]]);
  });
});

describe("replace", () => {
  it("puts the new task in the old one's slot and says which it replaces", async () => {
    const { root, application } = await vault();
    const [a, b, c, d] = await tasks(application, "A", "B", "C", "D");
    await adoptBrief(root, application, [a!, b!, c!]);
    const view = await change(application, "replace", b, d);
    expect(view.top3.map((item) => item.id)).toEqual([a, d, c]);
    expect(view.top3[1]).toMatchObject({ whyToday: "Your choice", replaces: { id: b, title: "B" } });
  });

  it("collapses a chain of replacements onto the original slot, and replacing back removes the entry", async () => {
    const { root, application } = await vault();
    const [a, b, c, d] = await tasks(application, "A", "B", "C", "D");
    await adoptBrief(root, application, [a!, b!]);
    await change(application, "replace", b, c);
    await change(application, "replace", c, d);
    expect((await frontmatterOf(overridePath(root))).replaced).toEqual([{ from: b, to: d }]);
    expect(top3Ids(application)).toEqual([a, d]);
    await change(application, "replace", d, b);
    expect((await frontmatterOf(overridePath(root))).replaced).toEqual([]);
    expect(top3Ids(application)).toEqual([a, b]);
  });

  it("carries a pin over to the replacement", async () => {
    const { application } = await vault();
    const [a, b, c, d] = await tasks(application, "A", "B", "C", "D");
    await change(application, "pin", a);
    await change(application, "replace", a, d);
    expect(focusOf(application).override).toMatchObject({ pinned: [d], replaced: [{ from: a, to: d }] });
    expect(focusOf(application).top3[0]).toMatchObject({ id: d, pinned: true });
    expect(top3Ids(application)).toEqual([d, b, c]);
  });

  it("refuses a source not in the Top 3, a target already in it, a finished or restricted target", async () => {
    const { root, application } = await vault();
    const [a, b, c, done, secret] = await tasks(application, "A", "B", "C", "Done one", "Private");
    await application.updateTask(done!, { status: "Done" }, application.object(done!).contentHash);
    await application.setSensitivity(secret!, "restricted", application.object(secret!).contentHash);
    await adoptBrief(root, application, [a!, b!]);
    await expect(change(application, "replace", c, a)).rejects.toThrow("is not in today's Top 3");
    await expect(change(application, "replace", a, b)).rejects.toThrow("is already in today's Top 3");
    await expect(change(application, "replace", a, done)).rejects.toThrow("Only an open task can replace");
    await expect(change(application, "replace", a, secret)).rejects.toThrow("Restricted tasks never appear in the Top 3");
    await expect(change(application, "replace", a)).rejects.toThrow("replacementId: missing");
    expect(focusOf(application).override).toBeUndefined();
  });

  it("a replacement made restricted later disappears and is counted, never named", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "Secret later");
    await adoptBrief(root, application, [a!, b!]);
    await change(application, "replace", b, c);
    await application.setSensitivity(c!, "restricted", application.object(c!).contentHash);
    const view = focusOf(application);
    expect(view.top3.map((item) => item.id)).toEqual([a]);
    expect(view.restrictedHidden).toBe(1);
    expect(JSON.stringify(view.top3)).not.toContain("Secret later");
  });
});

describe("dismiss", () => {
  it("removes a brief item for the day and lists it so it can be restored", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "C");
    await adoptBrief(root, application, [a!, b!, c!]);
    const view = await change(application, "dismiss", b);
    expect(view.top3.map((item) => item.id)).toEqual([a, c]);
    expect(view.dismissedTop3.map((item) => [item.id, item.object?.frontmatter.title])).toEqual([[b, "B"]]);
    await change(application, "restore", b);
    expect(top3Ids(application)).toEqual([a, b, c]);
    expect(focusOf(application).dismissedTop3).toEqual([]);
  });

  it("with no brief, the rule fills the slot with the next task, with its reason", async () => {
    const { application } = await vault();
    const first = await task(application, "First", { priority: "High", due_on: "2026-10-05" });
    const second = await task(application, "Second", { priority: "High" });
    const third = await task(application, "Third", { priority: "Medium" });
    const fourth = await task(application, "Fourth", { priority: "Low" });
    await change(application, "dismiss", first);
    const view = focusOf(application);
    expect(view.top3Source).toBe("rule");
    expect(view.top3.map((item) => [item.id, item.whyToday])).toEqual([[second, "High priority"], [third, "Medium priority"], [fourth, "Low priority"]]);
  });

  it("dismissing a pinned task unpins it; pinning a dismissed task brings it back", async () => {
    const { application } = await vault();
    const [a, b] = await tasks(application, "A", "B");
    await change(application, "pin", b);
    await change(application, "dismiss", b);
    expect(focusOf(application).override).toMatchObject({ pinned: [], dismissed: [b] });
    expect(top3Ids(application)).toEqual([a]);
    await change(application, "pin", b);
    expect(focusOf(application).override).toMatchObject({ pinned: [b], dismissed: [] });
    expect(top3Ids(application)).toEqual([b, a]);
  });

  it("refuses a task that is not in the Top 3", async () => {
    const { root, application } = await vault();
    const [a, b] = await tasks(application, "A", "B");
    await adoptBrief(root, application, [a!]);
    await expect(change(application, "dismiss", b)).rejects.toThrow("is not in today's Top 3");
  });

  it("reset clears every choice for the date", async () => {
    const { root, application } = await vault();
    const [a, b, c] = await tasks(application, "A", "B", "C");
    await adoptBrief(root, application, [a!, b!]);
    await change(application, "dismiss", a);
    await change(application, "replace", b, c);
    await change(application, "reset");
    expect(await frontmatterOf(overridePath(root))).toMatchObject({ pinned: [], replaced: [], dismissed: [] });
    expect(top3Ids(application)).toEqual([a, b]);
  });

  it("refuses an unknown action and a bad date", async () => {
    const { application } = await vault();
    const [a] = await tasks(application, "A");
    await expect(application.overrideFocus(date, { action: "promote", taskId: a })).rejects.toThrow("action: must be pin, unpin, replace, dismiss, restore or reset");
    await expect(application.overrideFocus("2026-13-40", { action: "dismiss", taskId: a })).rejects.toThrow("Not a calendar date");
  });
});

describe("a newer brief", () => {
  it("does not erase the overrides: they apply on top of the new Top 3", async () => {
    const { root, application } = await vault();
    const [a, b, c, d, e] = await tasks(application, "A", "B", "C", "D", "E");
    await adoptBrief(root, application, [a!, b!]);
    await change(application, "pin", c);
    await change(application, "dismiss", a);
    await change(application, "replace", b, d);
    const before = await readFile(overridePath(root), "utf8");

    await adoptBrief(root, application, [a!, e!, b!], { draft_key: "focus-0900", generated_at: "2026-10-05T09:00:00+02:00" }, "replan.md");
    expect(await readFile(overridePath(root), "utf8")).toBe(before);
    const view = focusOf(application);
    expect(view.brief!.generatedAt).toBe("2026-10-05T07:00:00.000Z");
    expect(view.top3.map((item) => item.id)).toEqual([c, e, d]);
  });
});

describe("max must-dos", () => {
  it("defaults to 3 and is a synced setting in settings/daily-focus.md", async () => {
    const { root, application } = await vault();
    expect(await application.getFocusSettings()).toEqual({ maxMustDos: 3 });
    expect(focusOf(application).maxMustDos).toBe(3);
    const saved = await application.saveFocusSettings({ maxMustDos: 2 });
    expect(saved.maxMustDos).toBe(2);
    expect(await frontmatterOf(path.join(root, "settings", "daily-focus.md"))).toMatchObject({ type: "app-setting", setting_key: "daily-focus", max_must_dos: 2 });
    await expect(application.saveFocusSettings({ maxMustDos: 1 })).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.saveFocusSettings({ maxMustDos: 1 }, "stale")).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect((await application.saveFocusSettings({ maxMustDos: 1 }, saved.contentHash)).maxMustDos).toBe(1);
  });

  it("refuses values outside 1 to 5", async () => {
    const { application } = await vault();
    for (const value of [0, 6, 2.5, "3", null]) await expect(application.saveFocusSettings({ maxMustDos: value })).rejects.toThrow("Max must-dos must be a whole number from 1 to 5");
  });

  it("caps the brief, the rule and pins; pins keep their place first", async () => {
    const { root, application } = await vault();
    const [a, b, c, d] = await tasks(application, "A", "B", "C", "D");
    await application.saveFocusSettings({ maxMustDos: 2 });
    expect(focusOf(application).top3).toHaveLength(2);
    await adoptBrief(root, application, [a!, b!, c!]);
    expect(top3Ids(application)).toEqual([a, b]);
    await expect(change(application, "pin", d)).rejects.toThrow("The Top 3 is full (2 must-dos)");
    await change(application, "pin", b);
    expect(top3Ids(application)).toEqual([b, a]);
  });

  it("a larger max lets the rule and pins go beyond the brief's three", async () => {
    const { root, application } = await vault();
    const [a, b, c, d, e] = await tasks(application, "A", "B", "C", "D", "E");
    await application.saveFocusSettings({ maxMustDos: 5 });
    expect(focusOf(application).top3).toHaveLength(5);
    await adoptBrief(root, application, [a!, b!, c!]);
    await change(application, "pin", d);
    await change(application, "pin", e);
    expect(top3Ids(application)).toEqual([d, e, a, b, c]);
  });
});
