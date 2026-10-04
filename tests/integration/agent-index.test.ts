import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication, type AgentIndexFile, type AgentIndexWriter } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemAgentIndexWriter, FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #43 (ADR 0009): the derived, disposable Agent Index in `_agent/`.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

/** 10:00 in Paris on Sunday 4 October 2026: "today" is 2026-10-04 in the user's time zone. */
const now = new Date("2026-10-04T08:00:00.000Z");
const day = 86_400_000;
const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * day).toISOString();
const date = (offsetDays: number) => at(offsetDays).slice(0, 10);

async function seed(root: string, folder: string, type: string, title: string, fields: Record<string, unknown> = {}, body = `# ${title}\n`) {
  const id = uuidV7();
  const relativePath = `${folder}/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}--${id}.md`;
  const frontmatter = { id, type, schema_version: 1, revision: 1, title, created_at: at(-60), updated_at: at(-60), updated_by_device: "test", ...fields };
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, relativePath), `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`);
  return { id, relativePath };
}

/** A long debounce by default: tests write explicitly, so no timer fires while a temp root is being removed. */
async function vault(writer?: AgentIndexWriter, debounceMs = 60_000) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-agent-index-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root), writer ?? new FilesystemAgentIndexWriter(root), { agentIndexDebounceMs: debounceMs, timeZone: "Europe/Paris" });
  return { root, application };
}

/** A small vault covering every Agent Index file. */
async function populated() {
  const { root, application } = await vault();
  // #54: internal domains come from the synced setting, written directly so no rebuild runs yet.
  await mkdir(path.join(root, "settings"), { recursive: true });
  await writeFile(path.join(root, "settings", "internal-domains.md"), `---\n${stringify({ id: uuidV7(), type: "app-setting", schema_version: 1, revision: 1, title: "Internal domains", created_at: at(-60), updated_at: at(-60), updated_by_device: "test", setting_key: "internal-domains", internal_domains: ["example.com"] }).trimEnd()}\n---\n# Internal domains\n`);
  const me = await seed(root, "people", "person", "Robin Doe", { given_name: "Robin", family_name: "Doe", is_self: true, identifiers: [{ kind: "email", value: "me@example.com" }] });
  const joel = await seed(root, "people", "person", "Joel Martin", { given_name: "Joel", family_name: "Martin", identifiers: [{ kind: "email", value: "joel@acme.fr" }] });
  const anna = await seed(root, "people", "person", "Anna Lee", { given_name: "Anna", family_name: "Lee", identifiers: [{ kind: "email", value: "anna.lee@example.com" }] });
  const project = await seed(root, "projects", "project", "Retail Media", { status: "active" });
  await seed(root, "projects", "project", "Old Pilot", { status: "completed" });
  const client = await seed(root, "clients", "client", "Acme", { status: "active" });
  await seed(root, "products", "product", "Promotions Engine", { status: "active" });
  const owned = { status: "Next", owner_person_id: me.id };
  const overdue = await seed(root, "tasks", "task", "Send Joel the sizing deck", { ...owned, priority: "High", due_on: date(-2), primary_project_id: project.id }, "# Deck\n\nSECRET-BODY-TEXT\n");
  const today = await seed(root, "tasks", "task", "Call Acme", { ...owned, due_at: "2026-10-04T15:00:00.000Z", due_timezone: "Europe/Paris", primary_client_id: client.id });
  const upcoming = await seed(root, "tasks", "task", "Draft PRD", { ...owned, due_on: date(3) });
  const undated = await seed(root, "tasks", "task", "Read pricing paper", { status: "Inbox", owner_person_id: me.id });
  await seed(root, "tasks", "task", "Finished thing", { status: "Done", owner_person_id: me.id, completed_at: at(-1) });
  await seed(root, "tasks", "task", "Anna's own task", { status: "Next", owner_person_id: anna.id });
  const waiting = await seed(root, "tasks", "task", "Joel to confirm budget", { status: "Waiting", owner_person_id: me.id, waiting_for_person_id: joel.id, updated_at: at(-5) });
  const openPoint = await seed(root, "open-points", "open-point", "Who owns the coupon API?", { status: "open", primary_project_id: project.id });
  await seed(root, "open-points", "open-point", "Settled question", { status: "resolved", resolved_at: "2026-10-01T08:00:00.000Z", resolution_summary: "Agreed in the steering call" });
  const recent = await seed(root, "decisions", "decision", "Launch in November", { status: "active", decision_text: "We launch the pilot in November.", decided_at: at(-3), primary_project_id: project.id });
  await seed(root, "decisions", "decision", "Old decision", { status: "active", decision_text: "Ancient.", decided_at: at(-40) });
  const past = await seed(root, "meetings", "meeting", "Acme weekly", { status: "scheduled", starts_at: at(-2), ends_at: at(-2 + 1 / 24), timezone: "Europe/Paris", attendee_ids: [me.id, joel.id], enrichment_state: "partial", external_refs: [{ provider: "google", external_id: "evt-1" }] });
  const note = await seed(root, "meetings", "meeting-note", "Acme weekly notes", { meeting_id: past.id });
  const next = await seed(root, "meetings", "meeting", "Planning", { status: "scheduled", starts_at: at(2), ends_at: at(2 + 1 / 24), timezone: "Europe/Paris", attendee_ids: [me.id, anna.id] });
  await seed(root, "meetings", "meeting", "Too old", { status: "scheduled", starts_at: at(-20), ends_at: at(-20 + 1 / 24), timezone: "Europe/Paris", attendee_ids: [] });
  await seed(root, "meetings", "meeting", "Too far", { status: "scheduled", starts_at: at(9), ends_at: at(9 + 1 / 24), timezone: "Europe/Paris", attendee_ids: [] });
  await seed(root, "connectors", "connector-account", "Google", { provider: "google", account_label: "work", external_account_id: "acct-1", status: "active", secret_ref: "keychain:google:SECRET-REF-VALUE", scopes: ["calendar"] });
  await application.rebuildIndex();
  return { root, application, ids: { me, joel, anna, project, client, overdue, today, upcoming, undated, waiting, openPoint, recent, past, note, next } };
}

const read = (root: string, name: string) => readFile(path.join(root, "_agent", name), "utf8");
const files = ["overview.md", "tasks.md", "waiting-on.md", "open-points.md", "decisions.md", "projects-clients-products.md", "people.md", "meetings.md", "pending-adoption.md"];
/** The part of a file between a heading and the next heading of the same level. */
const section = (content: string, heading: string) => content.split(heading)[1]?.split(/\n## /)[0] ?? "";

describe("Agent Index (#43)", () => {
  it("writes every summary file, each stating its generation time, with ID, title, path and key fields", async () => {
    const { root, application, ids } = await populated();
    await application.writeAgentIndex({ now });
    expect((await readdir(path.join(root, "_agent"))).sort()).toEqual([...files].sort());
    for (const name of files) {
      const content = await read(root, name);
      expect(content).toContain("generated_at: 2026-10-04T08:00:00.000Z");
      expect(content).toContain("Generated at 2026-10-04T08:00:00.000Z");
    }

    const tasks = await read(root, "tasks.md");
    expect(section(tasks, "## Overdue")).toContain("**Send Joel the sizing deck**");
    expect(section(tasks, "## Overdue")).toContain(`id: ${ids.overdue.id}`);
    expect(section(tasks, "## Overdue")).toContain(`path: ${ids.overdue.relativePath}`);
    expect(section(tasks, "## Overdue")).toMatch(/due: 2026-10-02 · priority: High · status: Next · project: Retail Media/);
    // due_at 17:00 Paris is today in the user's time zone.
    expect(section(tasks, "## Today")).toContain(ids.today.id);
    expect(section(tasks, "## Today")).toContain("client: Acme");
    expect(section(tasks, "## Upcoming")).toContain(ids.upcoming.id);
    expect(section(tasks, "## No date")).toContain(ids.undated.id);
    // Done tasks, other people's tasks and Waiting tasks are not "my open tasks".
    expect(tasks).not.toContain("Finished thing");
    expect(tasks).not.toContain("Anna's own task");
    expect(tasks).not.toContain(ids.waiting.id);

    const waiting = await read(root, "waiting-on.md");
    expect(waiting).toContain("## Joel - ext");
    expect(waiting).toContain(`id: ${ids.waiting.id}`);
    expect(waiting).toContain("age: 5d");

    const openPoints = await read(root, "open-points.md");
    expect(openPoints).toContain(`id: ${ids.openPoint.id}`);
    expect(openPoints).toContain("project: Retail Media");
    expect(openPoints).not.toContain("Settled question");

    const decisions = await read(root, "decisions.md");
    expect(decisions).toContain(`id: ${ids.recent.id}`);
    expect(decisions).toContain("decided: 2026-10-01");
    expect(decisions).toContain("We launch the pilot in November.");
    expect(decisions).not.toContain("Old decision");

    const work = await read(root, "projects-clients-products.md");
    expect(section(work, "## Projects")).toContain(ids.project.id);
    expect(section(work, "## Projects")).not.toContain("Old Pilot");
    expect(section(work, "## Clients")).toContain("Acme");
    expect(section(work, "## Products")).toContain("Promotions Engine");

    const people = await read(root, "people.md");
    expect(people).toMatch(/\*\*Joel - ext\*\*\n {2}id: [^\n]+ · name: Joel Martin · emails: joel@acme\.fr · external: yes/);
    expect(people).toMatch(/\*\*Anna\*\*\n {2}id: [^\n]+ · emails: anna\.lee@example\.com · external: no/);
    expect(people).toContain("self: yes");

    const meetings = await read(root, "meetings.md");
    expect(section(meetings, "## Last 14 days")).toContain(ids.past.id);
    expect(section(meetings, "## Last 14 days")).toContain("enrichment: partial");
    expect(section(meetings, "## Last 14 days")).toContain(`note: ${ids.note.relativePath}`);
    expect(section(meetings, "## Last 14 days")).toContain("calendar_event: evt-1");
    expect(section(meetings, "## Last 14 days")).toContain("attendees: Robin, Joel - ext");
    expect(section(meetings, "## Next 7 days")).toContain(ids.next.id);
    expect(section(meetings, "## Next 7 days")).toContain("enrichment: none");
    expect(meetings).not.toContain("Too old");
    expect(meetings).not.toContain("Too far");

    const overview = await read(root, "overview.md");
    expect(overview).toMatch(/task: 7 · `tasks\/`/);
    expect(overview).toContain("meeting-note: 1 · `meetings/`");
    expect(overview).toContain("Pending adoption: 0");
    for (const name of files.filter((file) => file !== "overview.md")) expect(overview).toContain(name);
  });

  it("lists the configured internal domains in overview.md, or says none are set, for the enrichment gate (#93)", async () => {
    const { root, application } = await populated();
    await application.writeAgentIndex({ now });
    expect(section(await read(root, "overview.md"), "## Internal domains").trim()).toBe("- example.com");

    const { root: bare, application: unset } = await vault();
    await unset.rebuildIndex();
    await unset.writeAgentIndex({ now });
    expect(section(await read(bare, "overview.md"), "## Internal domains").trim()).toBe("- none set");
  });

  it("excludes restricted objects everywhere and only counts them", async () => {
    const { root, application, ids } = await populated();
    const secretProject = await seed(root, "projects", "project", "Project Nightingale", { status: "active", sensitivity: "restricted" });
    await seed(root, "tasks", "task", "Hush task", { status: "Next", owner_person_id: ids.me.id, sensitivity: "restricted" });
    await seed(root, "tasks", "task", "Visible task in a restricted project", { status: "Next", owner_person_id: ids.me.id, primary_project_id: secretProject.id });
    await seed(root, "people", "person", "Hidden Person", { given_name: "Hidden", sensitivity: "restricted" });
    await seed(root, "decisions", "decision", "Hush decision", { status: "active", decision_text: "Hush.", decided_at: at(-1), sensitivity: "restricted" });
    await seed(root, "meetings", "meeting", "Hush meeting", { status: "scheduled", starts_at: at(1), ends_at: at(1.1), timezone: "Europe/Paris", attendee_ids: [], sensitivity: "restricted" });
    await application.rebuildIndex();
    await application.writeAgentIndex({ now });

    const all = (await Promise.all(files.map((name) => read(root, name)))).join("\n");
    for (const hidden of ["Nightingale", "Hush", "Hidden", secretProject.id]) expect(all).not.toContain(hidden);
    expect(await read(root, "tasks.md")).toContain("Visible task in a restricted project");
    expect(await read(root, "tasks.md")).toContain("project: (restricted)");
    expect(await read(root, "tasks.md")).toContain("restricted_excluded: 1");
    expect(await read(root, "people.md")).toContain("1 restricted not listed");
    expect(await read(root, "overview.md")).toContain("Restricted objects (counted, never listed): 5");
  });

  it("leaves out a meeting whose note is restricted, and never names a restricted person's ID (#63)", async () => {
    const { root, application, ids } = await populated();
    const hushMeeting = await seed(root, "meetings", "meeting", "Board prep", { status: "scheduled", starts_at: at(-1), ends_at: at(-1 + 1 / 24), timezone: "Europe/Paris", attendee_ids: [ids.me.id] });
    await seed(root, "meetings", "meeting-note", "Board prep notes", { meeting_id: hushMeeting.id, sensitivity: "restricted" });
    await seed(root, "tasks", "task", "Follow up from board prep", { status: "Next", owner_person_id: ids.me.id, source_meeting_id: hushMeeting.id });
    const hidden = await seed(root, "people", "person", "Hidden Person", { given_name: "Hidden", sensitivity: "restricted" });
    await seed(root, "tasks", "task", "Waiting on someone private", { status: "Waiting", owner_person_id: ids.me.id, waiting_for_person_id: hidden.id, updated_at: at(-2) });
    await application.rebuildIndex();
    await application.writeAgentIndex({ now });

    const meetings = await read(root, "meetings.md");
    expect(meetings).not.toContain("Board prep");
    expect(meetings).not.toContain(hushMeeting.id);
    expect(meetings).toContain("1 restricted not listed");
    expect(await read(root, "tasks.md")).toContain("meeting: (restricted)");
    const waiting = await read(root, "waiting-on.md");
    expect(waiting).toContain("Waiting on someone private");
    expect(waiting).not.toContain(hidden.id);
    const all = (await Promise.all(files.map((name) => read(root, name)))).join("\n");
    for (const leaked of ["Board prep", hushMeeting.id, hidden.id]) expect(all).not.toContain(leaked);
  });

  it("leaves out a meeting marked restricted itself, exactly as when its note is restricted (#86)", async () => {
    const { root, application, ids } = await populated();
    const hushMeeting = await seed(root, "meetings", "meeting", "Board prep", { status: "scheduled", starts_at: at(-1), ends_at: at(-1 + 1 / 24), timezone: "Europe/Paris", attendee_ids: [ids.me.id] });
    const note = await seed(root, "meetings", "meeting-note", "Board prep notes", { meeting_id: hushMeeting.id });
    await seed(root, "tasks", "task", "Follow up from board prep", { status: "Next", owner_person_id: ids.me.id, source_meeting_id: hushMeeting.id });
    await application.rebuildIndex();
    // The toggle on the meeting page writes through this guarded use case.
    await application.setSensitivity(hushMeeting.id, "restricted", application.object(hushMeeting.id).contentHash);
    await application.writeAgentIndex({ now });

    const meetings = await read(root, "meetings.md");
    expect(meetings).toContain("1 restricted not listed");
    expect(await read(root, "tasks.md")).toContain("meeting: (restricted)");
    const all = (await Promise.all(files.map((name) => read(root, name)))).join("\n");
    for (const leaked of ["Board prep", hushMeeting.id, note.relativePath]) expect(all).not.toContain(leaked);
  });

  it("lists pending drafts and patches as \"pending adoption\", restricted drafts counted only", async () => {
    const { root, application } = await populated();
    await mkdir(path.join(root, "_inbox", "drafts"), { recursive: true });
    await mkdir(path.join(root, "_inbox", "patches"), { recursive: true });
    await writeFile(path.join(root, "_inbox", "drafts", "deck.md"), "---\nlifeos_draft: 1\nkind: task\ndraft_key: phone-1\norigin: user-dictated\ntitle: Ping Joel about the deck\n---\nbody\n");
    await writeFile(path.join(root, "_inbox", "drafts", "private.md"), "---\nlifeos_draft: 1\nkind: task\ndraft_key: phone-2\norigin: user-dictated\ntitle: Doctor appointment\nsensitivity: restricted\n---\n");
    await writeFile(path.join(root, "_inbox", "drafts", "broken.md"), "no front matter at all\n");
    await writeFile(path.join(root, "_inbox", "patches", "done.md"), "---\nlifeos_patch: 1\ndraft_key: patch-1\ntarget: Draft PRD\n---\n");
    await application.writeAgentIndex({ now });

    const pending = await read(root, "pending-adoption.md");
    expect(pending).toMatch(/\*\*Ping Joel about the deck\*\* \(pending adoption\)\n {2}path: _inbox\/drafts\/deck\.md · kind: task · draft_key: phone-1 · origin: user-dictated/);
    expect(pending).toContain("path: _inbox/drafts/broken.md");
    expect(pending).toContain("path: _inbox/patches/done.md");
    expect(pending).not.toContain("Doctor");
    expect(pending).toContain("1 restricted not listed");
    expect(await read(root, "overview.md")).toContain("Pending adoption: 4");
  });

  it("regenerates after index rebuilds, debounced, and never reads _agent/ back", async () => {
    // #55: the debounce runs on a fake clock, so a slow machine cannot fire it early or late; the test awaits the write itself.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const writes: AgentIndexFile[][] = [];
      let written!: () => void;
      const firstWrite = new Promise<void>((resolve) => { written = resolve; });
      const writer: AgentIndexWriter = { async write(files) { writes.push(files); written(); } };
      const { application } = await vault(writer, 100);
      await application.rebuildIndex();
      vi.advanceTimersByTime(60);
      await application.rebuildIndex();
      vi.advanceTimersByTime(60);
      await application.createEntity("task", { title: "Fresh task" });
      vi.advanceTimersByTime(99);
      expect(writes).toHaveLength(0); // each rebuild restarted the 100 ms wait
      vi.advanceTimersByTime(1);
      await firstWrite;
      expect(writes).toHaveLength(1);
      expect(writes[0]!.find((file) => file.name === "tasks.md")!.content).toContain("Fresh task");
      await application.writeAgentIndex(); // serialized behind the debounced write, so its status is settled
      expect(application.agentIndexStatus().generatedAt).toBeDefined();
    } finally { vi.useRealTimers(); }
  });

  it("is disposable: deleting or scribbling on _agent/ is harmless and overwritten", async () => {
    const { root, application } = await populated();
    await application.writeAgentIndex({ now });
    await rm(path.join(root, "_agent"), { recursive: true });
    await application.rebuildIndex();
    expect((await application.health()).diagnostics).toEqual([]);
    await application.writeAgentIndex({ now });
    expect((await readdir(path.join(root, "_agent"))).sort()).toEqual([...files].sort());

    await writeFile(path.join(root, "_agent", "tasks.md"), "---\nid: not-an-object\n---\nbogus\n");
    await writeFile(path.join(root, "_agent", "notes-by-hand.md"), "kept\n");
    await application.rebuildIndex();
    expect((await application.health()).diagnostics).toEqual([]);
    await application.writeAgentIndex({ now });
    expect(await read(root, "tasks.md")).not.toContain("bogus");
    expect(await read(root, "notes-by-hand.md")).toBe("kept\n");
  });

  it("never writes secrets or object bodies", async () => {
    const { root, application } = await populated();
    await application.writeAgentIndex({ now });
    const all = (await Promise.all(files.map((name) => read(root, name)))).join("\n");
    expect(all).not.toContain("SECRET-REF-VALUE");
    expect(all).not.toContain("secret_ref");
    expect(all).not.toContain("SECRET-BODY-TEXT");
  });

  it("reports a failed write in System Health and recovers on the next success", async () => {
    let fail = true;
    const writer: AgentIndexWriter = { async write() { if (fail) throw new Error("disk full"); } };
    const { application } = await vault(writer);
    await application.rebuildIndex();
    await application.writeAgentIndex({ now });
    expect((await application.health()).diagnostics).toEqual(["_agent/: Agent Index not written (disk full)"]);
    fail = false;
    await application.writeAgentIndex({ now });
    expect((await application.health()).diagnostics).toEqual([]);
  });
});
