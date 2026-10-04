import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #73: creating an audit event must not list the (flat, ever-growing) audit folder.
// The folder is made unlistable (write and enter only): any listing fails, while creating a file still works.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(path.join(root, "audit"), 0o755).catch(() => undefined);
    await chmod(path.join(root, "people"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function rootWithUnlistable(folder: string) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-audit-no-scan-"));
  roots.push(root);
  await mkdir(path.join(root, folder), { recursive: true });
  await chmod(path.join(root, folder), 0o300);
  return root;
}

const auditId = "01995d3e-912b-7357-8aa6-9816c1ad90b1";
const personId = "01995d3e-912b-7357-8aa6-9816c1ad90b2";
const common = { schema_version: 1, revision: 1, created_at: "2026-10-04T08:00:00Z", updated_at: "2026-10-04T08:00:00Z", updated_by_device: "test-device" };

describe("audit-event creates skip the sibling-ID scan", () => {
  it("writes an audit event without listing the audit folder", async () => {
    const root = await rootWithUnlistable("audit");
    const store = new MarkdownObjectStore(root);
    const relativePath = `audit/2026-10-04-0800-object-updated--${auditId}.md`;
    await store.write({
      relativePath,
      frontmatter: { ...common, id: auditId, type: "audit-event", title: "object.updated", occurred_at: "2026-10-04T08:00:00Z", actor_type: "system", action: "object.updated" },
      body: "# object.updated\n"
    });
    expect(await readFile(path.join(root, relativePath), "utf8")).toContain("object.updated");
  });

  it("other creates still scan their folder for a duplicate ID (#58)", async () => {
    const root = await rootWithUnlistable("people");
    const store = new MarkdownObjectStore(root);
    await expect(store.write({
      relativePath: `people/2026-10-04-0800-example--${personId}.md`,
      frontmatter: { ...common, id: personId, type: "person", title: "Example", given_name: "Example" },
      body: "# Example\n"
    })).rejects.toMatchObject({ code: "EACCES" });
  });
});
