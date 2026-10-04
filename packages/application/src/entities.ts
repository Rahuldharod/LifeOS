import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import { decisionPeopleIds } from "./decisions.js";
import { openPointPeopleIds } from "./open-points.js";
import { dueDate, isRestricted } from "./support.js";

export type EntityType = "task" | "project" | "client" | "product" | "person";

const entityTypes: EntityType[] = ["task", "project", "client", "product", "person"];
/** Envelope fields the user may set on any entity (#30). `origin` is deliberately absent: it is fixed at creation. */
const envelopeFields = ["area", "sensitivity"];

/** Tasks, projects, clients, products and people: CRUD, the Today view and rollups. */
export class EntitiesModule {
  constructor(private readonly ctx: AppContext) {}

  entities(type: EntityType) {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === type && !object.frontmatter.deleted_at);
  }

  async createEntity(type: EntityType, fields: Record<string, unknown>) {
    const title = typeof fields.title === "string" ? fields.title.trim() : "";
    if (!title) throw new Error("Title is required");
    const now = new Date().toISOString();
    const id = uuidV7();
    const folders = { task: "tasks", project: "projects", client: "clients", product: "products", person: "people" } as const;
    const allowed: Record<typeof type, string[]> = {
      task: ["status", "priority", "owner_person_id", "waiting_for_person_id", "expected_output", "due_on", "due_at", "due_timezone", "dependency_ids", "primary_project_id", "primary_client_id", "primary_product_id"],
      project: ["status", "objective", "success_criteria", "owner_person_id", "primary_client_id", "primary_product_id", "start_on", "target_end_on"],
      client: ["status", "summary", "website_url", "primary_contact_person_id"],
      product: ["status", "description", "owner_person_id"],
      person: ["given_name", "family_name", "organization_name", "job_title", "timezone", "is_self"]
    };
    const selected = Object.fromEntries(Object.entries(fields).filter(([key, value]) => [...allowed[type], ...envelopeFields].includes(key) && value !== "" && value !== undefined));
    if (type === "task") {
      selected.status ??= "Inbox";
      selected.owner_person_id ??= (await this.ctx.ensureSelfPerson(now)).frontmatter.id;
    } else if (type === "person") {
      selected.given_name ??= title.split(/\s+/)[0];
    } else {
      selected.status ??= "active";
    }
    const created = await this.ctx.objects.write({ relativePath: `${folders[type]}/${markdownFileName(title, id, now)}`, frontmatter: { ...this.ctx.envelope(id, type, title, now), ...selected }, body: `# ${title}\n` });
    await this.ctx.writeAudit(`${type}.created`, id, now, {});
    await this.ctx.rebuildIndex();
    return created;
  }

  async updateEntity(id: string, fields: Record<string, unknown>, expectedHash: string) {
    const current = this.ctx.required(id);
    if (!entityTypes.includes(current.frontmatter.type as EntityType)) throw new Error("Object type is not editable through this workspace");
    const type = current.frontmatter.type as EntityType;
    const allowed: Record<typeof type, string[]> = {
      task: ["title", "status", "priority", "owner_person_id", "waiting_for_person_id", "expected_output", "due_on", "due_at", "due_timezone", "dependency_ids", "primary_project_id", "primary_client_id", "primary_product_id"],
      project: ["title", "status", "objective", "success_criteria", "owner_person_id", "primary_client_id", "primary_product_id", "start_on", "target_end_on", "completed_at"],
      client: ["title", "status", "summary", "website_url", "primary_contact_person_id"],
      product: ["title", "status", "description", "owner_person_id"],
      person: ["title", "given_name", "family_name", "organization_name", "job_title", "timezone", "is_self"]
    };
    const selected = Object.fromEntries(Object.entries(fields).filter(([key]) => [...allowed[type], ...envelopeFields].includes(key)));
    if (selected.area === "" || selected.area === null) selected.area = undefined;
    if (typeof selected.title === "string" && !selected.title.trim()) throw new Error("Title is required");
    const now = new Date().toISOString();
    if (type === "task") {
      if (selected.status === "Done") selected.completed_at = now; else if (selected.status) selected.completed_at = undefined;
      if (selected.status === "Cancelled") selected.cancelled_at = now; else if (selected.status) selected.cancelled_at = undefined;
      if (selected.status && selected.status !== "Waiting") selected.waiting_for_person_id = undefined;
    }
    // #87: saving an automatically created person counts as reviewing it.
    if (type === "person" && current.frontmatter.review_state === "unreviewed") selected.review_state = "reviewed";
    const updated = await this.ctx.update(current, selected, { expectedHash, now });
    await this.ctx.writeAudit(`${type}.updated`, id, now, { fields: Object.keys(selected) });
    await this.ctx.rebuildIndex();
    return updated;
  }

  async deleteEntity(id: string, expectedHash: string) {
    const current = this.ctx.required(id);
    if (!entityTypes.includes(current.frontmatter.type as EntityType)) throw new Error("Object type cannot be deleted through this workspace");
    if (current.frontmatter.type === "person" && current.frontmatter.is_self === true) throw new Error("The self person cannot be deleted");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, { deleted_at: now }, { expectedHash, now });
    await this.ctx.writeAudit(`${current.frontmatter.type}.deleted`, id, now, {});
    await this.ctx.rebuildIndex();
    return updated;
  }

  tasks() {
    return this.entities("task");
  }

  async updateTask(id: string, changes: Record<string, unknown>, expectedHash: string) {
    const task = this.ctx.required(id, "task");
    const now = new Date().toISOString();
    const allowed = ["title", "status", "priority", "owner_person_id", "waiting_for_person_id", "due_on", "due_at", "due_timezone", "expected_output", "primary_project_id", "primary_client_id", "primary_product_id", "dependency_ids"];
    const safe = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.includes(key)));
    if (safe.status === "Done") safe.completed_at = now; else safe.completed_at = undefined;
    if (safe.status === "Cancelled") safe.cancelled_at = now; else safe.cancelled_at = undefined;
    const updated = await this.ctx.update(task, safe, { expectedHash, now });
    await this.ctx.writeAudit("task.updated", id, now, { changes: safe });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /** `date` is the user's local calendar date (YYYY-MM-DD); without it, the UTC date. */
  today(date?: string) {
    const active = this.entities("task").filter((object) => !["Done", "Cancelled"].includes(String(object.frontmatter.status)));
    const today = date ?? new Date().toISOString().slice(0, 10);
    return {
      tasks: active,
      overdue: active.filter((task) => Boolean(dueDate(task) && dueDate(task)! < today)),
      dueToday: active.filter((task) => dueDate(task) === today),
      upcoming: active.filter((task) => Boolean(dueDate(task) && dueDate(task)! > today)).sort((a, b) => String(dueDate(a)).localeCompare(String(dueDate(b)))),
      waiting: active.filter((task) => task.frontmatter.status === "Waiting"),
      // Restricted tasks are never Daily Focus inputs (ADR 0010), so the deterministic Top 3 skips them too.
      topThree: this.ruleCandidates(today).slice(0, 3),
      reviewCount: this.ctx.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.status === "pending").length
    };
  }

  /**
   * The deterministic Top 3 rule, as a full ranking: active tasks by priority, then due date, each with
   * its visible reason. #47 takes as many as the max must-dos allows, skipping dismissed ones.
   * Restricted tasks are never Daily Focus inputs (ADR 0010), so the rule skips them too.
   */
  ruleCandidates(today: string) {
    const ranked = this.entities("task").filter((task) => !["Done", "Cancelled"].includes(String(task.frontmatter.status)) && !isRestricted(task)).sort((a, b) => {
      const priority = (value: unknown) => value === "High" ? 0 : value === "Medium" ? 1 : value === "Low" ? 2 : 3;
      return priority(a.frontmatter.priority) - priority(b.frontmatter.priority) || String(dueDate(a) ?? "9999").localeCompare(String(dueDate(b) ?? "9999"));
    });
    return ranked.map((task) => ({ task, reason: dueDate(task) && dueDate(task)! <= today ? "Due or overdue" : task.frontmatter.priority ? `${task.frontmatter.priority} priority` : "Active commitment" }));
  }

  rollups(type: "client" | "product" | "person") {
    const field = type === "client" ? "primary_client_id" : type === "product" ? "primary_product_id" : "owner_person_id";
    return this.entities(type).map((entity) => ({
      entity,
      related: this.ctx.index.all().filter((object) => !object.frontmatter.deleted_at && (object.frontmatter[field] === entity.frontmatter.id || (Array.isArray(object.frontmatter.attendee_ids) && object.frontmatter.attendee_ids.includes(entity.frontmatter.id))
        // #41: a decision concerns its linked people and its source meeting's attendees, as in the Decisions person filter.
        || (type === "person" && object.frontmatter.type === "decision" && decisionPeopleIds(this.ctx, object).includes(entity.frontmatter.id))
        // #42: likewise for open points, plus their owner; resolved and closed ones stay listed.
        || (type === "person" && object.frontmatter.type === "open-point" && openPointPeopleIds(this.ctx, object).includes(entity.frontmatter.id))))
    }));
  }

  projects() {
    const meetings = this.ctx.index.all().filter((object) => object.frontmatter.type === "meeting");
    return this.entities("project").map((project) => {
      const meetingIds = meetings.filter((meeting) => meeting.frontmatter.primary_project_id === project.frontmatter.id).map((meeting) => meeting.frontmatter.id);
      const tasks = this.tasks().filter((task) => task.frontmatter.primary_project_id === project.frontmatter.id || meetingIds.includes(String(task.frontmatter.source_meeting_id)));
      const decisions = this.ctx.index.all().filter((object) => object.frontmatter.type === "decision" && object.frontmatter.primary_project_id === project.frontmatter.id);
      // #42: every open point of the project, resolved and closed included; the UI counts the open ones.
      const openPoints = this.ctx.index.all().filter((object) => object.frontmatter.type === "open-point" && object.frontmatter.primary_project_id === project.frontmatter.id && !object.frontmatter.deleted_at);
      const projectMeetings = meetings.filter((meeting) => meetingIds.includes(meeting.frontmatter.id));
      const peopleIds = new Set(projectMeetings.flatMap((meeting) => Array.isArray(meeting.frontmatter.attendee_ids) ? meeting.frontmatter.attendee_ids.filter((id): id is string => typeof id === "string") : []));
      return { project, tasks, meetings: projectMeetings, decisions, openPoints, people: [...peopleIds].map((id) => this.ctx.index.get(id)).filter((person): person is LifeOSObject => Boolean(person)) };
    });
  }
}
