import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { httpError } from "../../apps/server/src/http-errors.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function open(root: string, device: string) {
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), undefined, device);
  await application.rebuildIndex();
  return application;
}

describe("calendar preferences (synced settings file)", () => {
  it("starts empty, persists to settings/ and is visible to a second device on the same data folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-settings-"));
    roots.push(root);
    const laptop = await open(root, "laptop");
    expect(await laptop.getCalendarPreferences()).toEqual({ disabledCalendarIds: [] });

    const saved = await laptop.saveCalendarPreferences({ disabledCalendarIds: ["gym", "gym"], defaultCalendarId: "work" });
    expect(saved).toMatchObject({ disabledCalendarIds: ["gym"], defaultCalendarId: "work" });
    const file = await readFile(path.join(root, "settings", "calendar-preferences.md"), "utf8");
    expect(file).toContain("type: app-setting");
    expect(file).toContain("default_calendar_id: work");

    const phone = await open(root, "phone");
    expect(await phone.getCalendarPreferences()).toMatchObject({ disabledCalendarIds: ["gym"], defaultCalendarId: "work" });
  });

  it("clears the default, bumps the revision and rejects a stale write with a 409", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-settings-"));
    roots.push(root);
    const application = await open(root, "laptop");
    const first = await application.saveCalendarPreferences({ disabledCalendarIds: [], defaultCalendarId: "work" });
    const second = await application.saveCalendarPreferences({ disabledCalendarIds: [] }, first.contentHash);
    expect(second.defaultCalendarId).toBeUndefined();
    expect(await readFile(path.join(root, "settings", "calendar-preferences.md"), "utf8")).not.toContain("default_calendar_id");
    expect(await readFile(path.join(root, "settings", "calendar-preferences.md"), "utf8")).toContain("revision: 2");

    const stale = await application.saveCalendarPreferences({ disabledCalendarIds: ["x"] }, first.contentHash).catch((error) => error);
    expect(httpError(stale).statusCode).toBe(409);
    const missingHash = await application.saveCalendarPreferences({ disabledCalendarIds: ["x"] }).catch((error) => error);
    expect(httpError(missingHash).statusCode).toBe(409);
  });
});
