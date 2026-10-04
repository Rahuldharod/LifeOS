import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #76: until the user's own addresses are set, System Health and Today say so (not only Settings).

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-self-email-warning-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "integration-test");
  await application.rebuildIndex();
  return application;
}

const panels = (application: LifeOSApplication) => application.todayPanels({ date: "2026-10-05", now: new Date("2026-10-05T08:00:00Z"), timeZone: "Europe/Paris" });

describe("self email warning (#76)", () => {
  it("warns in System Health and Today while no self email is set, and says nobody is External when domains are unset too", async () => {
    const application = await setup();
    const expected = { selfEmailsMissing: true, internalDomainsMissing: true };
    expect((await application.health()).setupWarning).toEqual(expected);
    expect((await panels(application)).setupWarning).toEqual(expected);
  });

  it("does not mention External once internal domains are set", async () => {
    const application = await setup();
    await application.saveInternalDomains(["example.com"], undefined);
    expect((await application.health()).setupWarning).toEqual({ selfEmailsMissing: true, internalDomainsMissing: false });
    expect((await panels(application)).setupWarning).toEqual({ selfEmailsMissing: true, internalDomainsMissing: false });
  });

  it("still warns that nobody is External when self emails are set but internal domains are not", async () => {
    const application = await setup();
    await application.saveSelfEmails(["me@example.com"], undefined);
    expect((await application.health()).setupWarning).toEqual({ selfEmailsMissing: false, internalDomainsMissing: true });
    expect((await panels(application)).setupWarning).toEqual({ selfEmailsMissing: false, internalDomainsMissing: true });
  });

  it("disappears once both settings are saved, and never turns health to attention", async () => {
    const application = await setup();
    expect((await application.health()).status).toBe("healthy");
    await application.saveSelfEmails(["me@example.com"], undefined);
    await application.saveInternalDomains(["example.com"], undefined);
    expect((await application.health()).setupWarning).toBeUndefined();
    expect((await panels(application)).setupWarning).toBeUndefined();
  });
});
