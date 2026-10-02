import { randomBytes } from "node:crypto";
import { z } from "zod";

export const objectTypes = [
  "person", "client", "product", "project", "meeting", "meeting-note",
  "knowledge-note", "task", "decision", "open-point", "source", "review-item",
  "agent-run", "audit-event", "connector-account", "sync-run", "daily-focus", "recurring-item", "app-setting"
] as const;

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

const id = z.uuid();
const ids = z.array(id);
const contextFields = { primary_project_id: id.optional(), primary_client_id: id.optional(), primary_product_id: id.optional() };
const schemas: Partial<Record<(typeof objectTypes)[number], z.ZodType>> = {
  "app-setting": envelopeSchema.extend({ type: z.literal("app-setting"), setting_key: z.string().min(1) }),
  person: envelopeSchema.extend({ type: z.literal("person"), given_name: z.string().min(1), is_self: z.boolean().optional() }),
  client: envelopeSchema.extend({ type: z.literal("client"), status: z.string().min(1), primary_contact_person_id: id.optional() }),
  product: envelopeSchema.extend({ type: z.literal("product"), status: z.string().min(1), owner_person_id: id.optional() }),
  project: envelopeSchema.extend({ type: z.literal("project"), status: z.string().min(1), owner_person_id: id.optional(), ...contextFields }),
  meeting: envelopeSchema.extend({ type: z.literal("meeting"), status: z.string().min(1), starts_at: z.iso.datetime(), ends_at: z.iso.datetime(), timezone: z.string().min(1), attendee_ids: ids, ...contextFields }),
  "meeting-note": envelopeSchema.extend({ type: z.literal("meeting-note"), meeting_id: id, people_ids: ids.optional(), source_ids: ids.optional(), asset_ids: ids.optional(), ...contextFields }),
  "knowledge-note": envelopeSchema.extend({ type: z.literal("knowledge-note"), source_ids: ids.min(1), related_object_ids: ids.optional() }),
  source: envelopeSchema.extend({ type: z.literal("source"), source_type: z.string().min(1), captured_at: z.iso.datetime(), ingestion_status: z.enum(["captured", "processed", "failed"]), fragments: z.array(z.object({ id: z.string().min(1), text: z.string(), locator: z.record(z.string(), z.unknown()).optional() })).optional() }),
  decision: envelopeSchema.extend({ type: z.literal("decision"), status: z.enum(["active", "superseded", "reversed"]), decision_text: z.string().min(1), decided_at: z.iso.datetime(), supersedes_decision_id: id.optional(), source_ids: ids.optional(), ...contextFields }).refine((value) => value.supersedes_decision_id !== value.id, "A decision cannot supersede itself"),
  "open-point": envelopeSchema.extend({ type: z.literal("open-point"), status: z.enum(["open", "resolved", "closed"]), source_ids: ids.optional(), ...contextFields }),
  "review-item": envelopeSchema.extend({ type: z.literal("review-item"), review_type: z.string().min(1), target_object_type: z.enum(objectTypes), proposed_fields: z.record(z.string(), z.unknown()), field_evidence: z.record(z.string(), z.array(z.object({ source_id: id, fragment_id: z.string().min(1) }))).optional(), confidence_label: z.enum(["High", "Medium", "Low"]), status: z.enum(["pending", "accepted", "rejected"]), operation_id: id }),
  "agent-run": envelopeSchema.extend({ type: z.literal("agent-run"), operation: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), prompt_version: z.string().min(1), status: z.enum(["running", "succeeded", "failed"]), started_at: z.iso.datetime(), completed_at: z.iso.datetime().optional(), related_object_ids: ids.optional() }),
  "audit-event": envelopeSchema.extend({ type: z.literal("audit-event"), occurred_at: z.iso.datetime(), actor_type: z.enum(["person", "agent", "system"]), action: z.string().min(1), object_id: id.optional() }),
  "connector-account": envelopeSchema.extend({ type: z.literal("connector-account"), provider: z.string().min(1), account_label: z.string().min(1), external_account_id: z.string().min(1), status: z.enum(["active", "disconnected", "error"]), secret_ref: z.string().min(1), scopes: z.array(z.string()) }),
  "sync-run": envelopeSchema.extend({ type: z.literal("sync-run"), connector_account_id: id, resource_type: z.string().min(1), status: z.enum(["running", "succeeded", "failed"]), started_at: z.iso.datetime(), completed_at: z.iso.datetime().optional() })
};

export type ObjectType = typeof objectTypes[number];
export type ObjectEnvelope = z.infer<typeof envelopeSchema>;
export type LifeOSObject = { frontmatter: ObjectEnvelope; body: string; relativePath: string; contentHash: string };

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

export function validateFrontmatter(value: unknown): ObjectEnvelope {
  const envelope = envelopeSchema.parse(value);
  if (envelope.type === "task") taskSchema.parse(value);
  else schemas[envelope.type]?.parse(value);
  return envelope;
}
