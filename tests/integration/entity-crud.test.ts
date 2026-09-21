import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

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
  });
});
