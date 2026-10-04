import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { areas, envelopeWriteProblem, origins, originOf, sensitivities, sensitivityOf, validateFrontmatter } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #30: origin (set once, never changed), sensitivity (toggleable) and Area vocabulary on the Object Envelope.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const repo = process.cwd(); // vitest runs from the repository root
const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const header = (id: string, type: string, title: string, extra: string) => `---\nid: ${id}\ntype: ${type}\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\n${extra}---\n# ${title}\n`;
const self = header(selfId, "person", "You", "given_name: You\nis_self: true\n");
const legacyTask = (extra = "") => header(taskId, "task", "Legacy", `status: Inbox\nowner_person_id: ${selfId}\n${extra}`);

async function vault(files: Record<string, string> = {}, calendar = false) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-envelope-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar ? new MockCalendarConnector() : undefined);
  await application.rebuildIndex();
  const file = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");
  return { root, application, file };
}

describe("origin", () => {
  it("is set to app on objects the user creates in the app, and written to the file", async () => {
    const { application, file } = await vault();
    const task = await application.createEntity("task", { title: "Call plumber" });
    expect(task.frontmatter.origin).toBe("app");
    expect(await file(task.relativePath)).toMatch(/^origin: app$/m);
    expect(sensitivityOf(task.frontmatter)).toBe("normal");
    expect(task.frontmatter.sensitivity).toBeUndefined();
  });

  it("is calendar for the meeting and the people and project the calendar event brought in", async () => {
    const { application } = await vault({}, true);
    const [event] = await application.listCalendarEvents();
    const workspace = await application.createMeetingFromEvent(event!.externalId);
    expect(workspace.meeting.frontmatter.origin).toBe("calendar");
    expect(workspace.context.project?.frontmatter.origin).toBe("calendar");
    for (const person of workspace.context.people) expect(person.frontmatter.origin).toBe("calendar");
    // The note holds what the user types, so it is an app object even though the event triggered it.
    expect(workspace.note?.frontmatter.origin).toBe("app");
  });

  it("reads as app when missing, and editing a legacy object does not invent one", async () => {
    const { application, file } = await vault({ "people/self.md": self, "tasks/legacy.md": legacyTask() });
    const legacy = application.object(taskId);
    expect(originOf(legacy.frontmatter)).toBe("app");
    expect(sensitivityOf(legacy.frontmatter)).toBe("normal");
    await application.updateTask(taskId, { status: "Next" }, legacy.contentHash);
    expect(await file("tasks/legacy.md")).not.toMatch(/^origin:/m);
  });

  it("never changes through any use case", async () => {
    const { application } = await vault({}, true);
    const task = await application.createEntity("task", { title: "Keep origin", origin: "external" });
    expect(task.frontmatter.origin).toBe("app");
    const updated = await application.updateEntity(task.frontmatter.id, { title: "Still app", origin: "imported" }, task.contentHash);
    expect(updated.frontmatter.origin).toBe("app");
    const [event] = await application.listCalendarEvents();
    const { note } = await application.createMeetingFromEvent(event!.externalId);
    const edited = await application.updateNoteMetadata(note!.frontmatter.id, { title: "Renamed", origin: "agent-extracted" }, note!.contentHash);
    expect(edited.frontmatter.origin).toBe("app");
    const restricted = await application.setSensitivity(task.frontmatter.id, "restricted", updated.contentHash);
    expect(restricted.frontmatter.origin).toBe("app");
  });

  it("is enforced as immutable by the envelope write rule", () => {
    const previous = { origin: "calendar" as const };
    expect(envelopeWriteProblem({ origin: "calendar" }, previous)).toBeUndefined();
    expect(envelopeWriteProblem({ origin: "app" }, previous)).toMatch(/origin cannot change/i);
    expect(envelopeWriteProblem({}, {})).toBeUndefined();
    expect(envelopeWriteProblem({ origin: "app" }, {})).toBeUndefined();
    expect(envelopeWriteProblem({ origin: "external" }, {})).toMatch(/origin cannot change/i);
  });

  it("rejects files with an unknown origin or sensitivity as invalid, naming the field", async () => {
    const { application } = await vault({ "people/self.md": self, "tasks/a.md": legacyTask("origin: scraped\nsensitivity: secret\n") });
    const diagnostic = (await application.health()).diagnostics.find((entry) => entry.startsWith("tasks/a.md"));
    expect(diagnostic).toContain(`(id ${taskId})`);
    expect(diagnostic).toContain("origin");
    expect(diagnostic).toContain("sensitivity");
  });
});

describe("sensitivity", () => {
  it("toggles on any object, writes an audit event, and back again", async () => {
    const { application, file } = await vault({}, true);
    const [event] = await application.listCalendarEvents();
    const { meeting } = await application.createMeetingFromEvent(event!.externalId);
    const restricted = await application.setSensitivity(meeting.frontmatter.id, "restricted", meeting.contentHash);
    expect(restricted.frontmatter.sensitivity).toBe("restricted");
    expect(restricted.frontmatter.revision).toBe(meeting.frontmatter.revision + 1);
    expect(await file(restricted.relativePath)).toMatch(/^sensitivity: restricted$/m);
    expect((await application.listObjects()).some((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "object.sensitivity-changed" && object.frontmatter.object_id === meeting.frontmatter.id)).toBe(true);
    const normal = await application.setSensitivity(meeting.frontmatter.id, "normal", restricted.contentHash);
    expect(sensitivityOf(normal.frontmatter)).toBe("normal");
  });

  it("is idempotent, rejects unknown values and stale hashes", async () => {
    const { application } = await vault();
    const task = await application.createEntity("task", { title: "Private" });
    const once = await application.setSensitivity(task.frontmatter.id, "restricted", task.contentHash);
    const again = await application.setSensitivity(task.frontmatter.id, "restricted", once.contentHash);
    expect(again.frontmatter.revision).toBe(once.frontmatter.revision);
    await expect(application.setSensitivity(task.frontmatter.id, "secret" as never, once.contentHash)).rejects.toThrow(/normal or restricted/);
    await expect(application.setSensitivity(task.frontmatter.id, "normal", task.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
  });

  it("can be set through entity and note edits", async () => {
    const { application } = await vault({}, true);
    const client = await application.createEntity("client", { title: "Acme", sensitivity: "restricted" });
    expect(client.frontmatter.sensitivity).toBe("restricted");
    const cleared = await application.updateEntity(client.frontmatter.id, { sensitivity: "normal" }, client.contentHash);
    expect(cleared.frontmatter.sensitivity).toBe("normal");
    const [event] = await application.listCalendarEvents();
    const { note } = await application.createMeetingFromEvent(event!.externalId);
    const restrictedNote = await application.updateNoteMetadata(note!.frontmatter.id, { sensitivity: "restricted" }, note!.contentHash);
    expect(restrictedNote.frontmatter.sensitivity).toBe("restricted");
    await expect(application.updateNoteMetadata(note!.frontmatter.id, { sensitivity: "hidden" }, restrictedNote.contentHash)).rejects.toThrow(/normal or restricted/);
  });
});

describe("area", () => {
  it("accepts the six agreed values on new writes", async () => {
    const { application } = await vault();
    expect([...areas]).toEqual(["work", "maintenance", "household", "learning", "personal-projects", "personal-growth"]);
    for (const area of areas) expect((await application.createEntity("project", { title: `P ${area}`, area })).frontmatter.area).toBe(area);
  });

  it("rejects other values on create and update, writing nothing", async () => {
    const { application } = await vault();
    const before = (await application.listObjects()).length;
    await expect(application.createEntity("task", { title: "Bad", area: "Work" })).rejects.toThrow(/Area "Work" is not one of work, maintenance/);
    await expect(application.createEntity("project", { title: "Bad", area: "finance" })).rejects.toThrow(/Area "finance"/);
    expect((await application.listObjects()).length).toBe(before);
    const project = await application.createEntity("project", { title: "Good", area: "work" });
    await expect(application.updateEntity(project.frontmatter.id, { area: "health" }, project.contentHash)).rejects.toThrow(/Area "health"/);
    const cleared = await application.updateEntity(project.frontmatter.id, { area: "" }, project.contentHash);
    expect(cleared.frontmatter.area).toBeUndefined();
  });

  it("rejects other values on note metadata edits", async () => {
    const { application } = await vault({}, true);
    const [event] = await application.listCalendarEvents();
    const { note } = await application.createMeetingFromEvent(event!.externalId);
    await expect(application.updateNoteMetadata(note!.frontmatter.id, { area: "misc" }, note!.contentHash)).rejects.toThrow(/Area "misc"/);
    expect((await application.updateNoteMetadata(note!.frontmatter.id, { area: "learning" }, note!.contentHash)).frontmatter.area).toBe("learning");
  });

  it("loads existing files with legacy values and warns in System Health with the path", async () => {
    const { application } = await vault({ "people/self.md": self, "tasks/legacy.md": legacyTask("area: Admin\n") });
    expect(application.object(taskId).frontmatter.area).toBe("Admin");
    const health = await application.health();
    const warning = health.diagnostics.find((entry) => entry.startsWith("tasks/legacy.md"));
    expect(warning).toBe(`tasks/legacy.md (id ${taskId}): legacy Area "Admin" is not one of work, maintenance, household, learning, personal-projects, personal-growth; choose one when you next edit it`);
  });

  it("lets a legacy object be edited without touching its Area, then clears the warning once fixed", async () => {
    const { application, file } = await vault({ "people/self.md": self, "tasks/legacy.md": legacyTask("area: Admin\n") });
    const next = await application.updateTask(taskId, { status: "Next" }, application.object(taskId).contentHash);
    expect(next.frontmatter.area).toBe("Admin");
    await expect(application.updateEntity(taskId, { area: "Other" }, next.contentHash)).rejects.toThrow(/Area "Other"/);
    await application.updateEntity(taskId, { area: "household" }, next.contentHash);
    expect(await file("tasks/legacy.md")).toMatch(/^area: household$/m);
    expect((await application.health()).diagnostics.some((entry) => entry.includes("legacy Area"))).toBe(false);
  });
});

describe("JSON schema and fixtures", () => {
  it("mirror the domain vocabularies", async () => {
    const common = JSON.parse(await readFile(path.join(repo, "schemas/objects/common.schema.json"), "utf8"));
    expect(common.properties.origin.enum).toEqual([...origins]);
    expect(common.properties.sensitivity.enum).toEqual([...sensitivities]);
    expect(common.properties.area.enum).toEqual([...areas]);
  });

  it("fixture validates and carries the new envelope fields", async () => {
    const fixture = await new MarkdownObjectStore(path.join(repo, "schemas/fixtures")).read("person-self.md");
    expect(validateFrontmatter(fixture.frontmatter)).toMatchObject({ origin: "app", sensitivity: "normal", area: "personal-growth" });
  });
});
