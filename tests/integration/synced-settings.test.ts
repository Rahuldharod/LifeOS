import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { AppContext, ObjectConflictError } from "../../packages/application/src/context.js";
import { SyncedSetting } from "../../packages/application/src/synced-settings.js";

// #117: every synced setting (ADR 0005) reads and saves its file through this one module.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const spec = {
  key: "example",
  title: "Example",
  body: "# Example\n\nWhat this setting does.\n",
  changedMessage: "Example settings changed on another device; reload and try again",
  removedMessage: "Example settings were removed; reload and try again"
};

async function setup(device = "laptop") {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-synced-settings-"));
  roots.push(root);
  return { root, setting: open(root, device) };
}

function open(root: string, device: string) {
  return new SyncedSetting(new AppContext(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, device), spec);
}

const file = (root: string) => path.join(root, "settings", "example.md");

describe("SyncedSetting (#117, ADR 0005)", () => {
  it("reads nothing before the first save, then creates the app-setting file with its key, fields and default body", async () => {
    const { root, setting } = await setup();
    expect(await setting.read()).toBeUndefined();

    const saved = await setting.save(() => ({ colour: "blue" }));

    expect(saved.frontmatter).toMatchObject({ type: "app-setting", title: "Example", revision: 1, setting_key: "example", colour: "blue", updated_by_device: "laptop" });
    expect(saved.body).toBe(spec.body);
    const read = await setting.read();
    expect(read?.contentHash).toBe(saved.contentHash);
    expect(await readFile(file(root), "utf8")).toContain("colour: blue");
  });

  it("an update bumps the revision, passes the current front matter to the field mapping and drops fields mapped to undefined", async () => {
    const { root, setting } = await setup();
    const first = await setting.save(() => ({ colour: "blue", size: 3 }));
    let seen: Record<string, unknown> | undefined;

    const second = await open(root, "phone").save((current) => { seen = current; return { colour: "red", size: undefined }; }, first.contentHash);

    expect(seen).toMatchObject({ colour: "blue", size: 3 });
    expect(second.frontmatter).toMatchObject({ revision: 2, colour: "red", updated_by_device: "phone", setting_key: "example", title: "Example" });
    expect(second.frontmatter.id).toBe(first.frontmatter.id);
    expect(second.frontmatter.created_at).toBe(first.frontmatter.created_at);
    expect(second.frontmatter).not.toHaveProperty("size");
  });

  it("refuses a save whose expected hash is stale, or missing for a file that exists, with the setting's message", async () => {
    const { root, setting } = await setup();
    const first = await setting.save(() => ({ colour: "blue" }));
    await open(root, "phone").save(() => ({ colour: "red" }), first.contentHash);

    const stale = await setting.save(() => ({ colour: "green" }), first.contentHash).catch((error: unknown) => error);
    const blind = await setting.save(() => ({ colour: "green" })).catch((error: unknown) => error);

    for (const error of [stale, blind]) {
      expect(error).toBeInstanceOf(ObjectConflictError);
      expect((error as Error).message).toBe(spec.changedMessage);
    }
    expect((await setting.read())?.frontmatter).toMatchObject({ colour: "red", revision: 2 });
  });

  it("refuses to recreate a file removed since it was read, with the setting's message", async () => {
    const { root, setting } = await setup();
    const first = await setting.save(() => ({ colour: "blue" }));
    await rm(file(root));

    const error = await setting.save(() => ({ colour: "green" }), first.contentHash).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ObjectConflictError);
    expect((error as Error).message).toBe(spec.removedMessage);
    expect(await setting.read()).toBeUndefined();
  });

  it("keeps a hand-added paragraph and unknown front matter when saving", async () => {
    const { root, setting } = await setup();
    await setting.save(() => ({ colour: "blue" }));
    const edited = (await readFile(file(root), "utf8"))
      .replace("colour: blue", "colour: blue\nmy_note: added by hand")
      .concat("\nA paragraph I added myself.\n");
    await writeFile(file(root), edited);
    const before = await setting.read();

    await setting.save(() => ({ colour: "red" }), before!.contentHash);

    const after = await readFile(file(root), "utf8");
    expect(after).toContain("my_note: added by hand");
    expect(after).toContain("colour: red");
    expect(after.endsWith(`${spec.body}\nA paragraph I added myself.\n`)).toBe(true);
  });
});

describe("every synced setting keeps its own conflict wording (#117)", () => {
  type Save = (app: LifeOSApplication, hash?: string) => Promise<unknown>;
  const settings: Array<{ file: string; save: Save; changed: string; removed: string }> = [
    { file: "backups", save: (app, hash) => app.saveBackupSettings({ offDriveFolder: "" }, hash), changed: "Backup settings changed on another device; reload and try again", removed: "Backup settings were removed; reload and try again" },
    { file: "calendar-preferences", save: (app, hash) => app.saveCalendarPreferences({ disabledCalendarIds: [] }, hash), changed: "Calendar preferences changed on another device; reload and try again", removed: "Calendar preferences were removed; reload and try again" },
    { file: "today", save: (app, hash) => app.saveTodaySettings({ briefTime: "07:00" }, hash), changed: "Today settings changed on another device; reload and try again", removed: "Today settings were removed; reload and try again" },
    { file: "daily-focus", save: (app, hash) => app.saveFocusSettings({ maxMustDos: 3 }, hash), changed: "The Daily Focus settings changed on another device; reload and try again", removed: "The Daily Focus settings were removed; reload and try again" },
    { file: "self-emails", save: (app, hash) => app.saveSelfEmails(["me@example.com"], hash), changed: "Your email addresses changed on another device; reload and try again", removed: "Your email addresses setting was removed; reload and try again" },
    { file: "internal-domains", save: (app, hash) => app.saveInternalDomains(["example.com"], hash), changed: "Internal domains changed on another device; reload and try again", removed: "Internal domains setting was removed; reload and try again" }
  ];

  it.each(settings)("$file: a stale save and a save after removal are conflicts with the setting's message", async ({ file: name, save, changed, removed }) => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-synced-settings-"));
    roots.push(root);
    const app = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), undefined, "laptop");
    await app.rebuildIndex();
    await save(app);

    const stale = await save(app, "stale").catch((error: unknown) => error);
    expect(stale).toMatchObject({ name: "ObjectConflictError", message: changed });
    await rm(path.join(root, "settings", `${name}.md`));
    const gone = await save(app, "gone").catch((error: unknown) => error);
    expect(gone).toMatchObject({ name: "ObjectConflictError", message: removed });
  });
});

describe("a hand-edited settings file round-trips through a save (#117)", () => {
  // Only the saved field, `revision` and the `updated_*` lines may differ; the order of the setting's own keys, unknown
  // front matter and the body stay byte for byte. (The envelope keys are always written in the schema's order, so the
  // file starts with them.)
  const updatedAt = /^updated_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
  const envelope = (title: string) => [
    "---",
    "id: 01995d3e-912b-7357-8aa6-9816c1ad90a5",
    "type: app-setting",
    "schema_version: 1",
    "revision: 4",
    `title: ${title}`,
    "created_at: 2026-09-01T08:00:00.000Z",
    "updated_at: 2026-09-02T08:00:00.000Z",
    "updated_by_device: desk-mac",
    "my_note: kept by hand"
  ];
  const body = (key: string) => [`setting_key: ${key}`, "---", "# Hand-written heading", "", "A paragraph I wrote myself.", ""];
  const expectLines = (actual: string, expected: Array<string | RegExp>) => {
    const lines = actual.split("\n");
    expect(lines).toHaveLength(expected.length);
    expected.forEach((line, index) => typeof line === "string" ? expect(lines[index]).toBe(line) : expect(lines[index]).toMatch(line));
  };

  async function app() {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-synced-settings-"));
    roots.push(root);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), undefined, "laptop");
    return { root, application };
  }

  it("calendar preferences", async () => {
    const { root, application } = await app();
    const before = [...envelope("Calendar preferences"), "unknown_flag: true", "default_calendar_id: work", "disabled_calendar_ids:", "  - personal", ...body("calendar-preferences")];
    await mkdir(path.join(root, "settings"), { recursive: true });
    await writeFile(path.join(root, "settings", "calendar-preferences.md"), before.join("\n"));
    await application.rebuildIndex();
    const { contentHash } = await application.getCalendarPreferences();

    await application.saveCalendarPreferences({ disabledCalendarIds: ["personal"], defaultCalendarId: "home" }, contentHash);

    const after = await readFile(path.join(root, "settings", "calendar-preferences.md"), "utf8");
    expectLines(after, before.map((line) => line === "revision: 4" ? "revision: 5" : line.startsWith("updated_at:") ? updatedAt : line === "updated_by_device: desk-mac" ? "updated_by_device: laptop" : line === "default_calendar_id: work" ? "default_calendar_id: home" : line));
  });

  it("backups", async () => {
    const { root, application } = await app();
    const folder = path.join(root, "off-drive");
    const before = [...envelope("Backups"), "off_drive_folders:", "  desk-mac: /Volumes/Backup/LifeOS", "unknown_flag: true", ...body("backups")];
    await mkdir(path.join(root, "settings"), { recursive: true });
    await writeFile(path.join(root, "settings", "backups.md"), before.join("\n"));
    await application.rebuildIndex();
    const { contentHash } = await application.getBackupSettings();

    await application.saveBackupSettings({ offDriveFolder: folder }, contentHash);

    const after = await readFile(path.join(root, "settings", "backups.md"), "utf8");
    expectLines(after, before.flatMap((line) => line === "revision: 4" ? ["revision: 5"] : line.startsWith("updated_at:") ? [updatedAt] : line === "updated_by_device: desk-mac" ? ["updated_by_device: laptop"] : line === "  desk-mac: /Volumes/Backup/LifeOS" ? [line, `  laptop: ${folder}`] : [line]));
  });
});
