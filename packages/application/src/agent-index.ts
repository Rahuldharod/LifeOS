import { type LifeOSObject } from "@lifeos/domain";
import type { AdoptionModule } from "./adoption.js";
import type { AppContext } from "./context.js";
import type { DecisionsModule } from "./decisions.js";
import { enrichmentStateOf } from "./enrichment.js";
import { personDisplayLabels, personEmails, internalDomainsOf } from "./people.js";
import type { AgentIndexFile, AgentIndexWriter, InboxFolder, InboxStore } from "./ports.js";
import { isLive, isMeetingRestricted, isRestricted, OneAtATime } from "./support.js";

/**
 * The Agent Index (#43, ADR 0009): small Markdown summaries in `_agent/` that an Agent on a phone reads
 * instead of scanning the vault. Derived from the in-memory index after each rebuild (debounced), never
 * read back, never authoritative. Restricted objects (ADR 0010) are counted, never listed. Only
 * whitelisted fields are written, never bodies, so no secret or private note text can leak.
 */

export const agentIndexContractVersion = 1;
export const agentIndexFileNames = ["overview.md", "tasks.md", "waiting-on.md", "open-points.md", "decisions.md", "projects-clients-products.md", "people.md", "meetings.md", "pending-adoption.md"] as const;
export const defaultAgentIndexDebounceMs = 1500;
export interface AgentIndexOptions { debounceMs?: number; timeZone?: string }
export interface AgentIndexStatus { generatedAt?: string; error?: string }

const day = 86_400_000;
const closedStatus = /^(done|completed|complete|closed|cancelled|canceled|archived|inactive|abandoned)$/i;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** One line, bold markers neutralised (so a title cannot break the entry), capped so an entry stays phone-sized. */
const clean = (value: unknown, max = 160) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().replace(/\*/g, "\\*");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
type Field = [string, string | number | undefined];
const ageDays = (since: string | undefined, now: Date) => since && !Number.isNaN(Date.parse(since)) ? `${Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / day))}d` : undefined;

export class AgentIndexModule {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly running = new OneAtATime();
  private state: AgentIndexStatus = {};
  private readonly debounceMs: number;
  readonly timeZone: string;

  constructor(private readonly ctx: AppContext, private readonly decisions: DecisionsModule, private readonly adoption: AdoptionModule, private readonly inbox?: InboxStore, private readonly writer?: AgentIndexWriter, options: AgentIndexOptions = {}) {
    this.debounceMs = options.debounceMs ?? defaultAgentIndexDebounceMs;
    this.timeZone = options.timeZone ?? "Europe/Paris";
  }

  /** Debounced: a burst of rebuilds (an adoption batch, a review acceptance) produces one write. */
  schedule() {
    if (!this.writer) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.write(), this.debounceMs);
    this.timer.unref?.();
  }

  /** Writes now (cancelling any pending timer). Writes are serialized; a failure is kept for System Health, never thrown. */
  write(options: { now?: Date } = {}): Promise<AgentIndexStatus> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.writer) return Promise.resolve(this.state);
    return this.running.run("write", async () => {
      try {
        const now = options.now ?? new Date();
        await this.writer!.write(await this.build(now));
        this.state = { generatedAt: now.toISOString() };
      } catch (error) {
        this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
      }
      return this.state;
    });
  }

  status(): AgentIndexStatus { return { ...this.state }; }

  diagnostics() {
    return this.state.error ? [`_agent/: Agent Index not written (${this.state.error})`] : [];
  }

  /** Builds every file from the in-memory index (and the raw `_inbox/` listing for pending drafts). */
  async build(now: Date): Promise<AgentIndexFile[]> {
    const objects = this.ctx.index.all().filter((object) => !object.frontmatter.deleted_at);
    /** ADR 0010: restricted objects, and meetings whose note is restricted (#63), are never named. */
    const meetingNotes = objects.filter((object) => object.frontmatter.type === "meeting-note");
    const hidden = (object: LifeOSObject) => object.frontmatter.type === "meeting" ? isMeetingRestricted(object, meetingNotes) : isRestricted(object);
    const live = objects.filter(isLive);
    const labels = new Map(personDisplayLabels(this.ctx.index.all(), internalDomainsOf(this.ctx.index)).map((label) => [label.id, label]));
    const self = live.find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true);
    const today = this.localDate(now.toISOString());
    const generated = now.toISOString();

    /** A linked object's name; a restricted target is named only as "(restricted)". */
    const name = (id: unknown) => {
      if (typeof id !== "string") return undefined;
      const object = this.ctx.index.get(id);
      if (!object) return id;
      if (hidden(object)) return "(restricted)";
      return object.frontmatter.type === "person" ? labels.get(id)?.label ?? clean(object.frontmatter.title) : clean(object.frontmatter.title);
    };
    const context = (object: LifeOSObject): Field[] => [["project", name(object.frontmatter.primary_project_id)], ["client", name(object.frontmatter.primary_client_id)], ["product", name(object.frontmatter.primary_product_id)]];
    const entry = (object: LifeOSObject, fields: Field[], title = clean(object.frontmatter.title)) =>
      `- **${title}**\n  ${[["id", object.frontmatter.id], ["path", object.relativePath], ...fields].filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `${key}: ${value}`).join(" · ")}`;
    /** A linked object's ID, left out when that object is restricted. */
    const visibleId = (id: unknown) => { const value = str(id); const object = value ? this.ctx.index.get(value) : undefined; return object && hidden(object) ? undefined : value; };
    /** Splits candidates into the listed ones and a restricted count. */
    const visible = (candidates: LifeOSObject[]) => ({ shown: candidates.filter((object) => !hidden(object)), restricted: candidates.filter(hidden).length });
    const file = (fileName: string, heading: string, restricted: number, sections: Array<[string, string[]]>, intro?: string): AgentIndexFile => {
      const front = `---\nlifeos_agent_index: ${agentIndexContractVersion}\ngenerated_at: ${generated}\ntime_zone: ${this.timeZone}\nrestricted_excluded: ${restricted}\n---\n`;
      const lines = [`# ${heading}`, "", `Generated at ${generated} (day boundaries in ${this.timeZone}). Derived from LifeOS; edit objects through drafts, never here.`];
      if (intro) lines.push("", intro);
      if (restricted) lines.push("", `${restricted} restricted not listed.`);
      for (const [title, entries] of sections) lines.push("", `## ${title}`, "", ...(entries.length ? entries : ["- none"]));
      return { name: fileName, content: `${front}${lines.join("\n")}\n` };
    };
    const ofType = (type: string) => live.filter((object) => object.frontmatter.type === type);

    // Tasks: mine and open; Waiting tasks belong to waiting-on.md.
    const tasks = visible(ofType("task").filter((task) => self && task.frontmatter.owner_person_id === self.frontmatter.id && ["Inbox", "Next"].includes(String(task.frontmatter.status))));
    const due = (task: LifeOSObject) => str(task.frontmatter.due_on) ?? (str(task.frontmatter.due_at) ? this.localDate(String(task.frontmatter.due_at)) : undefined);
    const rank = (value: unknown) => ({ High: 0, Medium: 1, Low: 2 } as Record<string, number>)[String(value)] ?? 3;
    const sorted = [...tasks.shown].sort((a, b) => (due(a) ?? "9999").localeCompare(due(b) ?? "9999") || rank(a.frontmatter.priority) - rank(b.frontmatter.priority) || String(a.frontmatter.title).localeCompare(String(b.frontmatter.title)));
    const taskEntry = (task: LifeOSObject) => entry(task, [["due", str(task.frontmatter.due_at) ?? due(task)], ["priority", str(task.frontmatter.priority)], ["status", str(task.frontmatter.status)], ...context(task), ["meeting", name(task.frontmatter.source_meeting_id)]]);
    const tasksFile = file("tasks.md", "My open tasks", tasks.restricted, [
      ["Overdue", sorted.filter((task) => due(task) && due(task)! < today).map(taskEntry)],
      ["Today", sorted.filter((task) => due(task) === today).map(taskEntry)],
      ["Upcoming", sorted.filter((task) => due(task) && due(task)! > today).map(taskEntry)],
      ["No date", sorted.filter((task) => !due(task)).map(taskEntry)]
    ], "Open tasks I own (Inbox and Next). Tasks waiting on someone are in waiting-on.md.");

    // Waiting on: grouped by the person waited for, oldest first.
    const waiting = visible(ofType("task").filter((task) => task.frontmatter.status === "Waiting"));
    const since = (task: LifeOSObject) => str(task.frontmatter.waiting_since) ?? str(task.frontmatter.updated_at);
    const groups = new Map<string, LifeOSObject[]>();
    for (const task of waiting.shown) {
      const key = name(task.frontmatter.waiting_for_person_id) ?? "Nobody named";
      groups.set(key, [...groups.get(key) ?? [], task]);
    }
    const waitingFile = file("waiting-on.md", "Waiting on", waiting.restricted, [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([person, entries]) => [person,
      entries.sort((a, b) => String(since(a)).localeCompare(String(since(b)))).map((task) => entry(task, [["age", ageDays(since(task), now)], ["waiting_for_id", visibleId(task.frontmatter.waiting_for_person_id)], ["due", str(task.frontmatter.due_at) ?? due(task)], ...context(task)]))]),
    "Tasks in Waiting status, by person. Age counts from the task's last change.");

    const openPoints = visible(ofType("open-point").filter((point) => point.frontmatter.status === "open"));
    const openPointsFile = file("open-points.md", "Open points", openPoints.restricted, [["Open", [...openPoints.shown].sort((a, b) => String(a.frontmatter.created_at).localeCompare(String(b.frontmatter.created_at)))
      .map((point) => entry(point, [["age", ageDays(str(point.frontmatter.created_at), now)], ["owner", name(point.frontmatter.owner_person_id)], ...context(point), ["meeting", name(point.frontmatter.source_meeting_id)]]))]]);

    const recentDecisions = visible(this.decisions.decisions({ from: new Date(now.getTime() - 30 * day).toISOString() }).filter(isLive));
    const decisionsFile = file("decisions.md", "Decisions, last 30 days", recentDecisions.restricted, [["Decisions", recentDecisions.shown.map((decision) => entry(decision, [
      ["decided", this.localDate(String(decision.frontmatter.decided_at))], ["status", str(decision.frontmatter.status)], ...context(decision), ["meeting", name(decision.frontmatter.source_meeting_id)],
      ["superseded_by", visibleId(decision.frontmatter.superseded_by_decision_id)], ["text", clean(decision.frontmatter.decision_text, 240)]]))]], "Newest first.");

    const active = (type: string) => visible(ofType(type).filter((object) => !closedStatus.test(String(object.frontmatter.status ?? ""))).sort((a, b) => String(a.frontmatter.title).localeCompare(String(b.frontmatter.title))));
    const [projects, clients, products] = [active("project"), active("client"), active("product")];
    const workFile = file("projects-clients-products.md", "Active projects, clients and products", projects.restricted + clients.restricted + products.restricted, [
      ["Projects", projects.shown.map((project) => entry(project, [["status", str(project.frontmatter.status)], ["owner", name(project.frontmatter.owner_person_id)], ["client", name(project.frontmatter.primary_client_id)], ["product", name(project.frontmatter.primary_product_id)], ["target_end", str(project.frontmatter.target_end_on)]]))],
      ["Clients", clients.shown.map((client) => entry(client, [["status", str(client.frontmatter.status)], ["contact", name(client.frontmatter.primary_contact_person_id)]]))],
      ["Products", products.shown.map((product) => entry(product, [["status", str(product.frontmatter.status)], ["owner", name(product.frontmatter.owner_person_id)]]))]
    ]);

    const people = visible(ofType("person"));
    const peopleFile = file("people.md", "People", people.restricted, [["People", [...people.shown].sort((a, b) => (labels.get(a.frontmatter.id)?.label ?? "").localeCompare(labels.get(b.frontmatter.id)?.label ?? "")).map((person) => {
      const label = labels.get(person.frontmatter.id);
      const fullName = clean(person.frontmatter.title);
      return entry(person, [["name", fullName !== label?.name ? fullName : undefined], ["emails", personEmails(person).join(", ")], ["external", label?.isExternal ? "yes" : "no"], ["organization", str(person.frontmatter.organization_name) && clean(person.frontmatter.organization_name)], ["self", person.frontmatter.is_self === true ? "yes" : undefined]], clean(label?.label ?? person.frontmatter.title));
    })]], "Labels are what the app shows; \" - ext\" marks External people. Use the ID in drafts when a name is ambiguous.");

    // Meetings from 14 days ago to 7 days ahead, with their note and enrichment state.
    const start = (meeting: LifeOSObject) => Date.parse(String(meeting.frontmatter.starts_at));
    const meetings = visible(ofType("meeting").filter((meeting) => start(meeting) >= now.getTime() - 14 * day && start(meeting) <= now.getTime() + 7 * day).sort((a, b) => start(a) - start(b)));
    const notes = new Map(ofType("meeting-note").filter((note) => !isRestricted(note)).map((note) => [String(note.frontmatter.meeting_id), note.relativePath]));
    const meetingEntry = (meeting: LifeOSObject) => {
      const refs = Array.isArray(meeting.frontmatter.external_refs) ? meeting.frontmatter.external_refs as Array<{ external_id?: unknown }> : [];
      const attendees = list(meeting.frontmatter.attendee_ids).map(name).filter((value) => value && value !== "(restricted)");
      return entry(meeting, [["starts", String(meeting.frontmatter.starts_at)], ["ends", str(meeting.frontmatter.ends_at)], ["timezone", str(meeting.frontmatter.timezone)], ["enrichment", enrichmentStateOf(meeting)], ["note", notes.get(meeting.frontmatter.id)],
        ["calendar_event", str(refs[0]?.external_id)], ["attendees", attendees.join(", ")], ...context(meeting)]);
    };
    const meetingsFile = file("meetings.md", "Meetings", meetings.restricted, [
      ["Last 14 days", meetings.shown.filter((meeting) => start(meeting) < now.getTime()).reverse().map(meetingEntry)],
      ["Next 7 days", meetings.shown.filter((meeting) => start(meeting) >= now.getTime()).map(meetingEntry)]
    ], "Enrichment: none, requested, enriched, partial or gave_up.");

    const pending = await this.pendingDrafts();
    const pendingFile = file("pending-adoption.md", "Pending adoption", pending.restricted, [["Drafts and patches in _inbox/", pending.entries]],
      "Agent drafts LifeOS has not adopted yet. They are not objects: treat their content as provisional.");

    // Overview: map of the data root, counts, freshness and what each file holds.
    const inbox = await this.adoption.inboxStatus();
    const counts = new Map<string, { count: number; folders: Set<string> }>();
    for (const object of objects) {
      const type = object.frontmatter.type;
      const current = counts.get(type) ?? { count: 0, folders: new Set<string>() };
      if (!isRestricted(object)) current.count += 1;
      if (object.relativePath.includes("/")) current.folders.add(`${object.relativePath.split("/")[0]}/`);
      counts.set(type, current);
    }
    const restrictedTotal = objects.filter(isRestricted).length;
    const overview = file("overview.md", "LifeOS Agent Index", restrictedTotal, [
      ["Freshness", [`- Generated at ${generated}. If this is more than 24 hours old, tell Rahul the index may be stale.`]],
      ["Inbox", [`- Pending adoption: ${inbox.awaiting} (see pending-adoption.md)`, `- Failed drafts: ${inbox.failed.length}`]],
      ["Files", [
        "- tasks.md: my open tasks, overdue / today / upcoming / no date", "- waiting-on.md: waiting on others, by person, with age", "- open-points.md: open points",
        "- decisions.md: decisions from the last 30 days", "- projects-clients-products.md: active projects, clients and products", "- people.md: people, labels, emails, external flag",
        "- meetings.md: meetings from the last 14 days and the next 7, with enrichment state", "- pending-adoption.md: drafts waiting in _inbox/"
      ]],
      ["Data root", [
        "- `_inbox/drafts/`, `_inbox/patches/`: where Agents write drafts; `_inbox/processed/`, `_inbox/failed/`: adoption outcomes; `_inbox/requests/`: Work Orders",
        "- `_agent/`: this derived index (disposable)",
        `- Restricted objects (counted, never listed): ${restrictedTotal}. Never open restricted files.`
      ]],
      ["Objects by type", [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([type, { count, folders }]) => `- ${type}: ${count} · ${[...folders].sort().map((folder) => `\`${folder}\``).join(", ")}`)]
    ], "Read the file that answers the question, then open the object at its path for detail. Paths are relative to the data root.");

    return [overview, tasksFile, waitingFile, openPointsFile, decisionsFile, workFile, peopleFile, meetingsFile, pendingFile];
  }

  private async pendingDrafts() {
    const entries: string[] = [];
    let restricted = 0;
    if (!this.inbox) return { entries, restricted };
    for (const folder of ["drafts", "patches"] as InboxFolder[]) {
      for (const listed of await this.inbox.list(folder)) {
        const draft = await this.inbox.read(folder, listed.name).catch(() => undefined);
        const fields = draft?.frontmatter ?? {};
        if (isRestricted({ frontmatter: fields as LifeOSObject["frontmatter"] })) { restricted += 1; continue; }
        const title = clean(str(fields.title) ?? str(fields.target) ?? listed.name);
        const details: Field[] = [["path", listed.relativePath], ["kind", str(fields.kind) ?? (folder === "patches" ? "patch" : undefined)], ["draft_key", str(fields.draft_key)], ["origin", str(fields.origin)], ["unreadable", draft ? draft.error : "could not be read"]];
        entries.push(`- **${title}** (pending adoption)\n  ${details.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${clean(value)}`).join(" · ")}`);
      }
    }
    return { entries, restricted };
  }

  /** The calendar date of an instant in the user's time zone. */
  private localDate(instant: string) {
    const parsed = new Date(instant);
    if (Number.isNaN(parsed.getTime())) return instant.slice(0, 10);
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(parsed);
  }
}
