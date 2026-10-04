import { randomBytes } from "node:crypto";
import { z } from "zod";

export const objectTypes = [
  "person", "client", "product", "project", "meeting", "meeting-note",
  "knowledge-note", "task", "decision", "open-point", "source", "review-item",
  "agent-run", "audit-event", "connector-account", "sync-run", "daily-focus", "recurring-item", "app-setting"
] as const;

/** Where an object came from (ADR 0010). Set at creation, never changed; missing reads as `app`. */
export const origins = ["app", "user-dictated", "agent-extracted", "calendar", "imported", "external"] as const;
/** `restricted` keeps an object away from Agents, Daily Focus, Work Orders and Slack (ADR 0010). Missing reads as `normal`. */
export const sensitivities = ["normal", "restricted"] as const;
/** The agreed Area vocabulary. New writes must use one; older files with other values still load, with a System Health warning. */
export const areas = ["work", "maintenance", "household", "learning", "personal-projects", "personal-growth"] as const;
export type Origin = typeof origins[number];
export type Sensitivity = typeof sensitivities[number];
export type Area = typeof areas[number];

export const envelopeSchema = z.object({
  id: z.uuid(),
  type: z.enum(objectTypes),
  schema_version: z.number().int().positive(),
  revision: z.number().int().positive(),
  title: z.string().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  updated_by_device: z.string().min(1),
  archived_at: z.iso.datetime().optional(),
  deleted_at: z.iso.datetime().optional(),
  origin: z.enum(origins).optional(),
  sensitivity: z.enum(sensitivities).optional(),
  // Read leniently: legacy values must still load. New writes are checked by `envelopeWriteProblem`.
  area: z.string().optional(),
  subjects: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional()
}).loose();

export const taskSchema = envelopeSchema.extend({
  type: z.literal("task"),
  status: z.enum(["Inbox", "Next", "Waiting", "Done", "Cancelled"]),
  priority: z.enum(["High", "Medium", "Low"]).optional(),
  owner_person_id: z.uuid(),
  waiting_for_person_id: z.uuid().optional(),
  due_on: z.iso.date().optional(),
  due_at: z.iso.datetime().optional(),
  due_timezone: z.string().optional(),
  completed_at: z.iso.datetime().optional(),
  cancelled_at: z.iso.datetime().optional(),
  dependency_ids: z.array(z.uuid()).optional()
}).superRefine((task, context) => {
  if (task.due_on && task.due_at) context.addIssue({ code: "custom", message: "due_on and due_at are mutually exclusive" });
  if (task.due_at && !task.due_timezone) context.addIssue({ code: "custom", message: "due_timezone is required with due_at" });
  if (task.waiting_for_person_id && task.status !== "Waiting") context.addIssue({ code: "custom", message: "waiting_for_person_id requires Waiting status" });
  if (task.status === "Done" && !task.completed_at) context.addIssue({ code: "custom", message: "completed_at is required for Done tasks" });
  if (task.status !== "Done" && task.completed_at) context.addIssue({ code: "custom", message: "completed_at is allowed only for Done tasks" });
  if (task.status === "Cancelled" && !task.cancelled_at) context.addIssue({ code: "custom", message: "cancelled_at is required for Cancelled tasks" });
  if (task.status !== "Cancelled" && task.cancelled_at) context.addIssue({ code: "custom", message: "cancelled_at is allowed only for Cancelled tasks" });
  if (task.dependency_ids?.includes(task.id)) context.addIssue({ code: "custom", message: "A task cannot depend on itself" });
});

/** Decision lifecycle (#41): `active` → `superseded` (via Supersede) or `reversed`; both are final. */
export const decisionStatuses = ["active", "superseded", "reversed"] as const;
export type DecisionStatus = typeof decisionStatuses[number];

const id = z.uuid();
const ids = z.array(id);
const contextFields = { primary_project_id: id.optional(), primary_client_id: id.optional(), primary_product_id: id.optional() };
/** Where a proposed field came from: a source object (`source_id`, set when the reference resolved) and/or the Agent's raw reference (`source_ref`), plus a fragment or a locator such as a timestamp or section. */
const evidenceSchema = z.object({ source_id: id.optional(), source_ref: z.string().min(1).optional(), fragment_id: z.string().min(1).optional(), locator: z.string().optional(), quote: z.string().optional() }).loose()
  .refine((entry) => entry.source_id !== undefined || entry.source_ref !== undefined, "evidence needs a source_id or a source_ref");
const schemas: Partial<Record<(typeof objectTypes)[number], z.ZodType>> = {
  "app-setting": envelopeSchema.extend({ type: z.literal("app-setting"), setting_key: z.string().min(1) }),
  // #38: `identifiers` holds email addresses ({ kind: email, value }); plain strings from hand edits are tolerated.
  person: envelopeSchema.extend({ type: z.literal("person"), given_name: z.string().min(1), family_name: z.string().optional(), is_self: z.boolean().optional(), identifiers: z.array(z.union([z.string(), z.object({ kind: z.string().min(1), value: z.string().min(1) }).loose()])).optional(), review_state: z.enum(["unreviewed", "reviewed"]).optional(), is_external: z.boolean().optional(), is_external_override: z.boolean().optional() }),
  client: envelopeSchema.extend({ type: z.literal("client"), status: z.string().min(1), primary_contact_person_id: id.optional() }),
  product: envelopeSchema.extend({ type: z.literal("product"), status: z.string().min(1), owner_person_id: id.optional() }),
  project: envelopeSchema.extend({ type: z.literal("project"), status: z.string().min(1), owner_person_id: id.optional(), ...contextFields }),
  meeting: envelopeSchema.extend({ type: z.literal("meeting"), status: z.string().min(1), starts_at: z.iso.datetime(), ends_at: z.iso.datetime(), timezone: z.string().min(1), attendee_ids: ids, ...contextFields }),
  "meeting-note": envelopeSchema.extend({ type: z.literal("meeting-note"), meeting_id: id, people_ids: ids.optional(), source_ids: ids.optional(), asset_ids: ids.optional(), ...contextFields }),
  "knowledge-note": envelopeSchema.extend({ type: z.literal("knowledge-note"), source_ids: ids.min(1), related_object_ids: ids.optional() }),
  source: envelopeSchema.extend({ type: z.literal("source"), source_type: z.string().min(1), captured_at: z.iso.datetime(), ingestion_status: z.enum(["captured", "processed", "failed"]), fragments: z.array(z.object({ id: z.string().min(1), text: z.string(), locator: z.record(z.string(), z.unknown()).optional() })).optional() }),
  decision: envelopeSchema.extend({ type: z.literal("decision"), status: z.enum(decisionStatuses), decision_text: z.string().min(1), rationale: z.string().optional(), decided_at: z.iso.datetime(), supersedes_decision_id: id.optional(), superseded_by_decision_id: id.optional(), source_meeting_id: id.optional(), source_ids: ids.optional(), people_ids: ids.optional(), ...contextFields }).superRefine((value, context) => {
    if (value.supersedes_decision_id === value.id || value.superseded_by_decision_id === value.id) context.addIssue({ code: "custom", message: "A decision cannot supersede itself" });
    if (value.superseded_by_decision_id && value.status !== "superseded") context.addIssue({ code: "custom", message: "superseded_by_decision_id is allowed only for superseded decisions" });
  }),
  // #46: the Agent-written morning brief (ADR 0011). Entries are kept loose; adoption checks them with path-aware reasons.
  "daily-focus": envelopeSchema.extend({ type: z.literal("daily-focus"), focus_on: z.iso.date(), generated_at: z.iso.datetime().optional(), top3: z.array(z.record(z.string(), z.unknown())).max(3).optional(), meeting_prep: z.array(z.record(z.string(), z.unknown())).max(3).optional(), defer_candidates: z.array(z.record(z.string(), z.unknown())).max(3).optional(), superseded_by_id: id.optional() }),
  "open-point": envelopeSchema.extend({ type: z.literal("open-point"), status: z.enum(["open", "resolved", "closed"]), source_ids: ids.optional(), ...contextFields }),
  "review-item": envelopeSchema.extend({ type: z.literal("review-item"), review_type: z.string().min(1), target_object_type: z.enum(objectTypes), proposed_fields: z.record(z.string(), z.unknown()), field_evidence: z.record(z.string(), z.array(evidenceSchema)).optional(), confidence_label: z.enum(["High", "Medium", "Low"]), status: z.enum(["pending", "accepted", "rejected"]), operation_id: id }),
  "agent-run": envelopeSchema.extend({ type: z.literal("agent-run"), operation: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), prompt_version: z.string().min(1), status: z.enum(["running", "succeeded", "failed"]), started_at: z.iso.datetime(), completed_at: z.iso.datetime().optional(), related_object_ids: ids.optional() }),
  "audit-event": envelopeSchema.extend({ type: z.literal("audit-event"), occurred_at: z.iso.datetime(), actor_type: z.enum(["person", "agent", "system", "external"]), action: z.string().min(1), object_id: id.optional() }),
  "connector-account": envelopeSchema.extend({ type: z.literal("connector-account"), provider: z.string().min(1), account_label: z.string().min(1), external_account_id: z.string().min(1), status: z.enum(["active", "disconnected", "error"]), secret_ref: z.string().min(1), scopes: z.array(z.string()) }),
  "sync-run": envelopeSchema.extend({ type: z.literal("sync-run"), connector_account_id: id, resource_type: z.string().min(1), status: z.enum(["running", "succeeded", "failed"]), started_at: z.iso.datetime(), completed_at: z.iso.datetime().optional() })
};

export type ObjectType = typeof objectTypes[number];
export type ObjectEnvelope = z.infer<typeof envelopeSchema>;
export type LifeOSObject = { frontmatter: ObjectEnvelope; body: string; relativePath: string; contentHash: string };

export function originOf(frontmatter: { origin?: unknown }): Origin {
  return (frontmatter.origin as Origin | undefined) ?? "app";
}

export function sensitivityOf(frontmatter: { sensitivity?: unknown }): Sensitivity {
  return (frontmatter.sensitivity as Sensitivity | undefined) ?? "normal";
}

export function isArea(value: unknown): value is Area {
  return areas.includes(value as Area);
}

export function areaProblem(value: unknown) {
  return `Area "${String(value)}" is not one of ${areas.join(", ")}`;
}

/**
 * Envelope rules for a write, given the object's previous front matter (`undefined` when new).
 * Origin may never change. Sensitivity must be a known value. Area must be in the vocabulary
 * unless it is the unchanged legacy value of an existing object, so old objects stay editable.
 */
export function envelopeWriteProblem(next: { origin?: unknown; sensitivity?: unknown; area?: unknown }, previous?: { origin?: unknown; area?: unknown }): string | undefined {
  if (previous && originOf(next) !== originOf(previous)) return `Origin cannot change (was ${originOf(previous)}, got ${String(next.origin)})`;
  if (next.sensitivity !== undefined && !sensitivities.includes(next.sensitivity as Sensitivity)) return `Sensitivity must be normal or restricted, got "${String(next.sensitivity)}"`;
  if (next.area !== undefined && !isArea(next.area) && next.area !== previous?.area) return areaProblem(next.area);
  return undefined;
}

/**
 * Lifecycle rules for an app write, given the previous front matter (`undefined` when new), which a
 * single-file schema cannot check. Decisions start `active`; only `active` may move, to `superseded`
 * or `reversed`; the supersede links, once written, never change. Open points (#42) belong here too.
 */
export function lifecycleWriteProblem(next: Record<string, unknown>, previous?: Record<string, unknown>): string | undefined {
  if (next.type !== "decision") return undefined;
  if (!previous) return next.status === "active" ? undefined : `A new decision must be active, got "${String(next.status)}"`;
  if (next.status !== previous.status && previous.status !== "active") return `A ${String(previous.status)} decision is final and cannot become ${String(next.status)}`;
  if (previous.supersedes_decision_id !== undefined && next.supersedes_decision_id !== previous.supersedes_decision_id) return "supersedes_decision_id cannot change once set";
  if (previous.supersedes_decision_id === undefined && next.supersedes_decision_id !== undefined) return "supersedes_decision_id can only be set when the decision is created";
  if (previous.superseded_by_decision_id !== undefined && next.superseded_by_decision_id !== previous.superseded_by_decision_id) return "superseded_by_decision_id cannot change once set";
  return undefined;
}

export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True for a UUID whose version nibble is 7 (time-ordered). New objects must use these. */
export function isUuidV7(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateFrontmatter(value: unknown): ObjectEnvelope {
  const envelope = envelopeSchema.parse(value);
  if (envelope.type === "task") taskSchema.parse(value);
  else schemas[envelope.type]?.parse(value);
  return envelope;
}
