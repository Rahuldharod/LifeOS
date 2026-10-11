import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #115: alone this finishes in well under a second, but a full parallel suite on a busy laptop has pushed it past
// Vitest's 5 s default. A per-test limit keeps the assertions strict; only the wall-clock allowance grows.
const SLOW_UNDER_LOAD_MS = 30_000;

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("entity CRUD", () => {
  it("creates, reads, updates and soft-deletes each managed entity type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-crud-"));
    roots.push(root);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "crud-test");
    await application.rebuildIndex();

    const person = await application.createEntity("person", { title: "Ada Lovelace", given_name: "Ada", job_title: "Engineer" });
    const client = await application.createEntity("client", { title: "Example Client", summary: "Customer" });
    const product = await application.createEntity("product", { title: "LifeOS", description: "Local-first workspace", owner_person_id: person.frontmatter.id });
    const project = await application.createEntity("project", { title: "Launch", objective: "Ship MVP", owner_person_id: person.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id });
    const task = await application.createEntity("task", { title: "Prepare launch", owner_person_id: person.frontmatter.id, primary_project_id: project.frontmatter.id });

    expect(application.entities("person").some((item) => item.frontmatter.id === person.frontmatter.id)).toBe(true);
    expect(application.entities("project")).toHaveLength(1);
    const updated = await application.updateEntity(task.frontmatter.id, { title: "Prepare launch brief", status: "Next", priority: "High" }, task.contentHash);
    expect(updated.frontmatter.title).toBe("Prepare launch brief");
    expect(updated.frontmatter.status).toBe("Next");
    await application.deleteEntity(updated.frontmatter.id, updated.contentHash);
    expect(application.entities("task")).toHaveLength(0);
    expect((await application.health()).status).toBe("healthy");
  }, SLOW_UNDER_LOAD_MS);

  it("persists task completion and waiting lifecycle metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-task-lifecycle-"));
    roots.push(root);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "task-lifecycle-test");
    await application.rebuildIndex();

    const self = await application.createEntity("person", { title: "Test User", given_name: "Test", is_self: true });
    const colleague = await application.createEntity("person", { title: "Sam Example", given_name: "Sam" });
    const initiallyWaiting = await application.createEntity("task", { title: "Waiting from creation", status: "Waiting", owner_person_id: self.frontmatter.id, waiting_for_person_id: colleague.frontmatter.id });
    const initiallyDone = await application.createEntity("task", { title: "Done from creation", status: "Done", owner_person_id: self.frontmatter.id });
    const initiallyCancelled = await application.createEntity("task", { title: "Cancelled from creation", status: "Cancelled", owner_person_id: self.frontmatter.id });
    expect(initiallyWaiting.frontmatter.waiting_since).toEqual(expect.any(String));
    expect(initiallyDone.frontmatter).toMatchObject({ status: "Done", reopen_status: "Next", completed_at: expect.any(String) });
    expect(initiallyCancelled.frontmatter).toMatchObject({ status: "Cancelled", cancelled_at: expect.any(String) });
    const created = await application.createEntity("task", { title: "Confirm launch", status: "Inbox", owner_person_id: self.frontmatter.id });
    const waiting = await application.updateEntity(created.frontmatter.id, { status: "Waiting", waiting_for_person_id: colleague.frontmatter.id }, created.contentHash);

    expect(waiting.frontmatter).toMatchObject({ status: "Waiting", waiting_for_person_id: colleague.frontmatter.id });
    expect(waiting.frontmatter.waiting_since).toEqual(expect.any(String));

    const completed = await application.updateEntity(waiting.frontmatter.id, { status: "Done" }, waiting.contentHash);
    expect(completed.frontmatter).toMatchObject({ status: "Done", reopen_status: "Waiting" });
    expect(completed.frontmatter.waiting_since).toBeUndefined();
    expect(completed.frontmatter.completed_at).toEqual(expect.any(String));

    const reopened = await application.updateEntity(completed.frontmatter.id, { status: "Next" }, completed.contentHash);
    expect(reopened.frontmatter).toMatchObject({ status: "Waiting", waiting_for_person_id: colleague.frontmatter.id });
    expect(reopened.frontmatter.reopen_status).toBeUndefined();
    expect(reopened.frontmatter.waiting_since).toEqual(expect.any(String));
    expect(reopened.frontmatter.completed_at).toBeUndefined();

  });

  it("reopens a legacy completed task as Next", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-task-legacy-reopen-"));
    roots.push(root);
    await mkdir(path.join(root, "tasks"), { recursive: true });
    await writeFile(path.join(root, "tasks/legacy.md"), `---
id: 01995d60-7baf-7c21-9c96-9c5d2f6a32ac
type: task
schema_version: 1
revision: 1
title: Legacy completion
created_at: 2026-10-01T08:00:00.000Z
updated_at: 2026-10-01T08:00:00.000Z
updated_by_device: old-device
status: Done
owner_person_id: 01995d3e-912b-7357-8aa6-9816c1ad90a5
completed_at: 2026-10-01T09:00:00.000Z
---
# Legacy completion
`);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "task-legacy-test");
    await application.rebuildIndex();
    const legacy = application.object("01995d60-7baf-7c21-9c96-9c5d2f6a32ac");
    const reopened = await application.updateEntity(legacy.frontmatter.id, { status: "Next" }, legacy.contentHash);
    expect(reopened.frontmatter.status).toBe("Next");
    expect(reopened.frontmatter.completed_at).toBeUndefined();
  });
});
