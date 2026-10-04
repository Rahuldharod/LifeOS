import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import * as shared from "@lifeos/shared";
import { contextLinkFields, isRestricted } from "../../packages/application/src/support.js";
import { isRestricted as webIsRestricted } from "../../apps/web/src/envelope.js";

// #75: the shared-helper clean-up. Behaviour-preserving, so these pin the behaviour the refactor must keep.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-helpers-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "integration-test");
  await application.rebuildIndex();
  return { root, application };
}

describe("one home for the context-link and restricted rules (#75)", () => {
  it("the application and the web app use the rules of @lifeos/shared", () => {
    expect(contextLinkFields).toBe(shared.contextLinkFields);
    expect(shared.contextLinkFields).toEqual(["primary_project_id", "primary_client_id", "primary_product_id"]);
    expect(webIsRestricted).toBe(shared.isRestricted);
  });

  it("only `sensitivity: restricted` is restricted; no object is not restricted", () => {
    expect(shared.isRestricted({})).toBe(false);
    expect(shared.isRestricted({ sensitivity: "normal" })).toBe(false);
    expect(shared.isRestricted({ sensitivity: "restricted" })).toBe(true);
    expect(isRestricted(undefined)).toBe(false);
    expect(isRestricted({ frontmatter: { sensitivity: "restricted" } })).toBe(true);
    expect(isRestricted({ frontmatter: {} })).toBe(false);
  });
});

describe("list settings: self emails and internal domains save the same way (#75)", () => {
  it("creates each setting file with its own title and explanation", async () => {
    const { root, application } = await setup();
    await application.saveSelfEmails(["me@example.com"], undefined);
    await application.saveInternalDomains(["example.com"], undefined);
    const emails = await readFile(path.join(root, "settings", "self-emails.md"), "utf8");
    const domains = await readFile(path.join(root, "settings", "internal-domains.md"), "utf8");
    expect(emails).toMatch(/title: My email addresses/);
    expect(emails).toContain("# My email addresses\n\nEvery address you use.");
    expect(emails).toMatch(/type: app-setting/);
    expect(domains).toMatch(/title: Internal domains/);
    expect(domains).toContain("# Internal domains\n\nEmail domains of your own organisations.");
    expect(domains).toMatch(/type: app-setting/);
  });

  it("names each setting in its conflict messages", async () => {
    const { application } = await setup();
    await expect(application.saveSelfEmails(["me@example.com"], "gone")).rejects.toThrow("Your email addresses setting was removed; reload and try again");
    await expect(application.saveInternalDomains(["example.com"], "gone")).rejects.toThrow("Internal domains setting was removed; reload and try again");
    await application.saveSelfEmails(["me@example.com"], undefined);
    await application.saveInternalDomains(["example.com"], undefined);
    await expect(application.saveSelfEmails(["me@example.com"], "stale")).rejects.toThrow("Your email addresses changed on another device; reload and try again");
    await expect(application.saveInternalDomains(["example.com"], "stale")).rejects.toThrow("Internal domains changed on another device; reload and try again");
  });

  it("keeps a revision count and the edited body on a second save", async () => {
    const { root, application } = await setup();
    const first = await application.saveInternalDomains(["example.com"], undefined);
    const second = await application.saveInternalDomains(["example.org"], first.contentHash);
    expect(second.domains).toEqual(["example.org"]);
    const file = await readFile(path.join(root, "settings", "internal-domains.md"), "utf8");
    expect(file).toMatch(/revision: 2/);
  });
});
