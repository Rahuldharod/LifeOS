import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #26 (U2): an invalid file shows up in System Health with its path, its ID if readable and a reason.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await chmod(path.join(root, "tasks", "locked.md"), 0o644).catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const timestamp = "2026-10-01T08:00:00Z";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const validTask = (id: string, extra = "") => `---\nid: ${id}\ntype: task\nschema_version: 1\nrevision: 1\ntitle: Valid task\ncreated_at: ${timestamp}\nupdated_at: ${timestamp}\nupdated_by_device: test\nstatus: Inbox\nowner_person_id: 01995d3e-912b-7357-8aa6-9816c1ad90a5\n${extra}---\n# Valid\n`;
const self = `---\nid: 01995d3e-912b-7357-8aa6-9816c1ad90a5\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: ${timestamp}\nupdated_at: ${timestamp}\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;

async function vault(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-diagnostics-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex());
  await application.rebuildIndex();
  return { root, application, health: await application.health() };
}

describe("path-aware diagnostics in System Health", () => {
  it("reports malformed YAML with the file path and the parse reason", async () => {
    const { health } = await vault({ "people/self.md": self, "tasks/broken.md": "---\ntitle: [unclosed\n---\nbody\n" });
    const issue = health.diagnostics.find((entry) => entry.startsWith("tasks/broken.md"));
    expect(issue).toMatch(/^tasks\/broken\.md: invalid YAML front matter \(.+\)/);
  });

  it("reports a schema failure with the path, the readable ID and the failing field", async () => {
    const { health } = await vault({ "people/self.md": self, "tasks/bad-status.md": validTask(taskId).replace("status: Inbox", "status: Someday") });
    const issue = health.diagnostics.find((entry) => entry.startsWith("tasks/bad-status.md"));
    expect(issue).toContain(`(id ${taskId})`);
    expect(issue).toMatch(/status/);
  });

  it("names the referring file and the missing ID for a broken reference", async () => {
    const missing = "01995d3e-912b-7357-8aa6-9816c1ad9999";
    const { health } = await vault({ "people/self.md": self, "tasks/orphan.md": validTask(taskId).replace("01995d3e-912b-7357-8aa6-9816c1ad90a5\n", `${missing}\n`) });
    expect(health.diagnostics).toContainEqual(expect.stringMatching(new RegExp(`^tasks/orphan\\.md \\(id ${taskId}\\): owner_person_id references missing object ${missing}`)));
  });

  it("reports an empty file and an unreadable file without crashing", async () => {
    const { root } = await vault({ "people/self.md": self });
    await mkdir(path.join(root, "tasks"), { recursive: true });
    await writeFile(path.join(root, "tasks", "empty.md"), "");
    await writeFile(path.join(root, "tasks", "locked.md"), validTask("01995d60-7baf-7c21-9c96-9c5d2f6a32ad"));
    await chmod(path.join(root, "tasks", "locked.md"), 0o000);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex());
    const { diagnostics } = await application.rebuildIndex();
    expect(diagnostics).toContain("tasks/empty.md: empty file");
    expect(diagnostics).toContainEqual(expect.stringMatching(/^tasks\/locked\.md: unreadable \(.*permission denied.*\)/i));
  });

  it("keeps loading valid files when one file is bad", async () => {
    const { application } = await vault({ "people/self.md": self, "tasks/good.md": validTask(taskId), "tasks/broken.md": "no front matter at all" });
    expect(application.tasks().map((task) => task.frontmatter.id)).toEqual([taskId]);
    expect((await application.health()).diagnostics).toContain("tasks/broken.md: missing YAML front matter");
  });
});
