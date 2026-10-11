// PB-010 (#101): the Tasks, Projects, Clients, Products and People forms save relationship links
// through the entity use cases. A new link must point at a live object of the right type; a link
// that is already stored survives a save of other fields even when its target is now archived or
// deleted; a cleared link (null) is removed.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-links-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "links-test");
  await application.rebuildIndex();
  return { root, application };
}

describe("entity relationship links (PB-010)", () => {
  it("saves a task's project, client and product when they point at live objects", async () => {
    const { application } = await setup();
    const project = await application.createEntity("project", { title: "Launch" });
    const client = await application.createEntity("client", { title: "Example Client" });
    const product = await application.createEntity("product", { title: "Widget" });
    const task = await application.createEntity("task", { title: "Prepare launch", primary_project_id: project.frontmatter.id });

    const updated = await application.updateEntity(task.frontmatter.id, { primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id }, task.contentHash);
    expect(updated.frontmatter).toMatchObject({ primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id });
    expect((await application.health()).status).toBe("healthy");
  });

  it("refuses a link to a missing, deleted, archived or wrong-type object and writes nothing", async () => {
    const { application } = await setup();
    const client = await application.createEntity("client", { title: "Example Client" });
    const gone = await application.createEntity("project", { title: "Gone" });
    await application.deleteEntity(gone.frontmatter.id, gone.contentHash);
    const shelved = await application.createEntity("project", { title: "Shelved" });
    await application.archiveObject(shelved.frontmatter.id, shelved.contentHash);
    const task = await application.createEntity("task", { title: "Prepare launch" });

    await expect(application.updateEntity(task.frontmatter.id, { primary_project_id: "0190a1b2-0000-7000-8000-000000000099" }, task.contentHash)).rejects.toThrow(/Project not found/);
    await expect(application.updateEntity(task.frontmatter.id, { primary_project_id: gone.frontmatter.id }, task.contentHash)).rejects.toThrow(/Project not found/);
    await expect(application.updateEntity(task.frontmatter.id, { primary_project_id: shelved.frontmatter.id }, task.contentHash)).rejects.toThrow(/Project not found/);
    await expect(application.updateEntity(task.frontmatter.id, { primary_project_id: client.frontmatter.id }, task.contentHash)).rejects.toThrow(/Project not found/);
    await expect(application.updateEntity(task.frontmatter.id, { owner_person_id: client.frontmatter.id }, task.contentHash)).rejects.toThrow(/Owner not found/);
    await expect(application.updateEntity(task.frontmatter.id, { dependency_ids: [gone.frontmatter.id] }, task.contentHash)).rejects.toThrow(/Task not found/);
    await expect(application.createEntity("project", { title: "Bad", primary_client_id: gone.frontmatter.id })).rejects.toThrow(/Client not found/);
    await expect(application.updateTask(task.frontmatter.id, { primary_project_id: gone.frontmatter.id }, task.contentHash)).rejects.toThrow(/Project not found/);
    expect(application.object(task.frontmatter.id).frontmatter.revision).toBe(task.frontmatter.revision);
  });

  it("keeps a stored link to an archived or deleted object when other fields are saved", async () => {
    const { application } = await setup();
    const owner = await application.createEntity("person", { title: "Ada Lovelace" });
    const project = await application.createEntity("project", { title: "Launch" });
    const blocker = await application.createEntity("task", { title: "Blocker" });
    const task = await application.createEntity("task", { title: "Prepare launch", owner_person_id: owner.frontmatter.id, primary_project_id: project.frontmatter.id, dependency_ids: [blocker.frontmatter.id] });
    await application.archiveObject(project.frontmatter.id, project.contentHash);
    await application.deleteEntity(blocker.frontmatter.id, blocker.contentHash);
    const ownerNow = application.object(owner.frontmatter.id);
    await application.deleteEntity(owner.frontmatter.id, ownerNow.contentHash);

    // The form sends the whole draft back, stale links included.
    const draft = { ...application.object(task.frontmatter.id).frontmatter, title: "Prepare launch brief" };
    const updated = await application.updateEntity(task.frontmatter.id, draft, application.object(task.frontmatter.id).contentHash);
    expect(updated.frontmatter.title).toBe("Prepare launch brief");
    expect(updated.frontmatter.primary_project_id).toBe(project.frontmatter.id);
    expect(updated.frontmatter.owner_person_id).toBe(owner.frontmatter.id);
    expect(updated.frontmatter.dependency_ids).toEqual([blocker.frontmatter.id]);

    // A kept dead entry does not stop a live one being added beside it.
    const other = await application.createEntity("task", { title: "Other" });
    const added = await application.updateEntity(task.frontmatter.id, { dependency_ids: [blocker.frontmatter.id, other.frontmatter.id] }, updated.contentHash);
    expect(added.frontmatter.dependency_ids).toEqual([blocker.frontmatter.id, other.frontmatter.id]);
  });

  it("clears an optional link sent as null, but never the task owner", async () => {
    const { application } = await setup();
    const contact = await application.createEntity("person", { title: "Grace Hopper" });
    const client = await application.createEntity("client", { title: "Example Client", primary_contact_person_id: contact.frontmatter.id });
    const cleared = await application.updateEntity(client.frontmatter.id, { primary_contact_person_id: null }, client.contentHash);
    expect(cleared.frontmatter.primary_contact_person_id).toBeUndefined();

    const task = await application.createEntity("task", { title: "Owned" });
    await expect(application.updateEntity(task.frontmatter.id, { owner_person_id: null }, task.contentHash)).rejects.toThrow(/Owner is required/);

    const project = await application.createEntity("project", { title: "Launch" });
    const dated = await application.updateEntity(task.frontmatter.id, { due_on: "2026-10-20", primary_project_id: project.frontmatter.id }, task.contentHash);
    const taskCleared = await application.updateEntity(task.frontmatter.id, { due_on: null, primary_project_id: null }, dated.contentHash);
    expect(taskCleared.frontmatter.due_on).toBeUndefined();
    expect(taskCleared.frontmatter.primary_project_id).toBeUndefined();
  });

  it("loads and saves an old task file without context links, keeping unknown front matter", async () => {
    const { root, application } = await setup();
    const task = await application.createEntity("task", { title: "Legacy" });
    const file = path.join(root, task.relativePath);
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("status: Inbox", "status: Inbox\ncustom_field: keep me"), "utf8");
    await application.rebuildIndex();
    const legacy = application.object(task.frontmatter.id);
    expect(legacy.frontmatter.primary_project_id).toBeUndefined();

    const project = await application.createEntity("project", { title: "Launch" });
    const updated = await application.updateEntity(task.frontmatter.id, { ...legacy.frontmatter, primary_project_id: project.frontmatter.id }, legacy.contentHash);
    expect(updated.frontmatter.primary_project_id).toBe(project.frontmatter.id);
    expect(updated.frontmatter.custom_field).toBe("keep me");
    expect(await readFile(file, "utf8")).toContain("custom_field: keep me");
  });
});
