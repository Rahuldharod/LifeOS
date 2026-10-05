import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #98: the live app has no AI provider. Saving a meeting note or preserving a source only saves;
// Claude proposes tasks, decisions and Knowledge Notes through the skills (ADR 0008).

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-no-mock-ai-"));
  roots.push(root);
  const open = (ai?: MockAiProvider) => new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new MockCalendarConnector(), ai, "test");
  const application = open();
  await application.rebuildIndex();
  return { root, application, open };
}

describe("without an AI provider (the live server)", () => {
  it("saving a meeting note raises no Review Items", async () => {
    const { application } = await vault();
    const [event] = await application.listCalendarEvents();
    const created = await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "Agreed to ship the pilot.\n");
    await application.updateBody(created.note!.frontmatter.id, "Agreed to ship the pilot.\nJoel sends the deck.\n", created.note!.contentHash);
    expect(application.reviews()).toHaveLength(0);
    await expect(application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === "agent-run"))).resolves.toHaveLength(0);
    await expect(application.processMeeting(created.meeting.frontmatter.id)).rejects.toThrow("AI provider is not configured");
    expect(application.reviews()).toHaveLength(0);
  });

  it("preserving a pasted source saves the Source and raises no Review Items", async () => {
    const { application } = await vault();
    const source = await application.ingestTextSource("Podcast transcript", "Personalisation beats discounts.");
    expect(source.frontmatter).toMatchObject({ type: "source", source_type: "pasted-text", title: "Podcast transcript" });
    expect(source.body).toContain("Personalisation beats discounts.");
    expect(application.reviews()).toHaveLength(0);
    expect(application.knowledge()).toHaveLength(0);
  });

  it("leaves Review Items raised earlier pending and acceptable", async () => {
    const { application, open } = await vault();
    await open(new MockAiProvider()).ingestTextSource("Earlier source", "Raised before #98.");
    await application.rebuildIndex();
    const [review] = application.reviews();
    expect(review?.frontmatter).toMatchObject({ status: "pending", target_object_type: "knowledge-note" });
    const note = await application.acceptReviewItem(review!.frontmatter.id);
    expect(note.frontmatter.type).toBe("knowledge-note");
  });
});

describe("server wiring", () => {
  const server = path.join(process.cwd(), "apps/server"); // vitest runs from the repository root

  it("never constructs the mock AI provider or offers a process route", async () => {
    const files = (await readdir(path.join(server, "src"), { recursive: true })).filter((file) => file.endsWith(".ts") && !file.includes(".test."));
    expect(files).toContain("main.ts");
    for (const file of files) {
      const source = await readFile(path.join(server, "src", file), "utf8");
      expect(source, file).not.toMatch(/MockAiProvider|@lifeos\/ai/);
      expect(source, file).not.toMatch(/\/meetings\/:id\/process/);
    }
    const manifest = JSON.parse(await readFile(path.join(server, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@lifeos/ai");
  });
});
