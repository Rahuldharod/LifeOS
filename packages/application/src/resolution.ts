import { uuidV7, type LifeOSObject, type ObjectType, type Origin } from "@lifeos/domain";
import { foldForSearch, type AppContext } from "./context.js";
import { personEmails } from "./people.js";
import { proposeReviewItem } from "./review-items.js";
import { byIdentifier, isLive, isRestricted, objectIdPattern, replayRoles, type ReplayRole } from "./support.js";

/**
 * Name resolution (#33, PRD "Object Contract"): turns draft references (a name, alias, email, object ID
 * or calendar event ID) into object IDs. Never guesses: zero or several matches come back as
 * `unknown` / `ambiguous`, and the caller raises a `link-resolution` Review Item for them.
 */

/** The draft reference fields, the object type each points at, and the field the link is stored in. */
export const referenceFields = {
  project: { type: "project", linkField: "primary_project_id", list: false },
  client: { type: "client", linkField: "primary_client_id", list: false },
  product: { type: "product", linkField: "primary_product_id", list: false },
  people: { type: "person", linkField: "people_ids", list: true },
  owner: { type: "person", linkField: "owner_person_id", list: false },
  waiting_for: { type: "person", linkField: "waiting_for_person_id", list: false },
  meeting: { type: "meeting", linkField: "source_meeting_id", list: false }
} as const satisfies Record<string, { type: ObjectType; linkField: string; list: boolean }>;
export type ReferenceField = keyof typeof referenceFields;

export interface Candidate { id: string; title: string }
export type Resolution =
  | { status: "resolved"; id: string }
  | { status: "ambiguous" | "unknown"; candidates: Candidate[] };
/** One reference that could not be linked; becomes a `link-resolution` Review Item. */
export interface UnresolvedReference { field: ReferenceField; reference: string; problem: "ambiguous" | "unknown"; candidates: Candidate[] }

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Case-, accent- and whitespace-insensitive form used for exact name matching. */
export const foldName = (value: string) => foldForSearch(value).trim().replace(/\s+/g, " ");
/** Subjects also ignore separators, so "retail-media", "retail_media" and "Retail Media" are one subject. */
export const foldSubject = (value: string) => foldForSearch(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];

export class ReferenceResolver {
  constructor(private readonly ctx: AppContext) {}

  /** Live = not tombstoned and not archived. Name matching also skips restricted objects; IDs reach them. */
  private live(type: ObjectType) {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === type && isLive(object));
  }

  private outcome(matches: LifeOSObject[]): Resolution | undefined {
    if (matches.length === 1) return { status: "resolved", id: matches[0]!.frontmatter.id };
    if (matches.length > 1) return { status: "ambiguous", candidates: matches.map((object) => ({ id: object.frontmatter.id, title: object.frontmatter.title })) };
    return undefined;
  }

  /**
   * People by email address, case-insensitively. The self person's addresses all lead to self. An email is an
   * identifier, so it reaches an archived person when no live one has it (decision 2026-10-10).
   */
  personByEmail(address: string): Resolution {
    const wanted = address.trim().toLowerCase();
    const matches = byIdentifier(this.ctx.index.all().filter((object) => object.frontmatter.type === "person" && personEmails(object).includes(wanted)));
    const live = matches.filter(isLive);
    return this.outcome(live.length ? live : matches) ?? { status: "unknown", candidates: [] };
  }

  resolve(type: ObjectType, reference: string): Resolution {
    const value = reference.trim();
    if (objectIdPattern.test(value)) {
      // #118: an explicit ID still reaches an archived object (old links keep working); only deleted is gone.
      const object = this.ctx.index.get(value);
      return object && object.frontmatter.type === type && !object.frontmatter.deleted_at ? { status: "resolved", id: value } : { status: "unknown", candidates: [] };
    }
    if (type === "meeting") {
      // A calendar event ID: one meeting per event, but duplicates (PB-004) are reported, not picked.
      const byEvent = this.live("meeting").filter((meeting) => Array.isArray(meeting.frontmatter.external_refs) &&
        (meeting.frontmatter.external_refs as unknown[]).some((ref) => (ref as { external_id?: unknown } | null)?.external_id === value));
      const found = this.outcome(byEvent);
      if (found) return found;
    }
    if (type === "person" && email.test(value)) {
      const found = this.personByEmail(value);
      if (found.status !== "unknown") return found;
    }
    const wanted = foldName(value);
    const candidates = this.live(type).filter((object) => !isRestricted(object));
    const byTitle = candidates.filter((object) => foldName(object.frontmatter.title) === wanted);
    // Recorded aliases; for people, their first name and full name count as recorded names too.
    const names = (object: LifeOSObject) => {
      const { aliases, given_name: given, family_name: family } = object.frontmatter as Record<string, unknown>;
      const extra = type === "person" && typeof given === "string" ? [given, ...(typeof family === "string" ? [`${given} ${family}`] : [])] : [];
      return [...strings(aliases), ...extra].map(foldName);
    };
    return this.outcome(byTitle) ?? this.outcome(candidates.filter((object) => names(object).includes(wanted))) ?? { status: "unknown", candidates: [] };
  }

  /**
   * Resolves every reference field present in a draft. Malformed values are returned as `issues`
   * ("field: reason") for a `DraftError`; anything unresolved is returned for Review Items.
   */
  resolveDraft(fields: Record<string, unknown>) {
    const issues: string[] = [];
    const links: Record<string, string | string[]> = {};
    const unresolved: UnresolvedReference[] = [];
    for (const [field, spec] of Object.entries(referenceFields) as Array<[ReferenceField, typeof referenceFields[ReferenceField]]>) {
      const raw = fields[field];
      if (raw === undefined || raw === null || raw === "") continue;
      let references: string[];
      if (spec.list) {
        if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" || typeof item === "number")) { issues.push(`${field}: must be a list of names, emails or IDs`); continue; }
        references = raw.map((item) => String(item).trim()).filter(Boolean);
      } else {
        if (typeof raw !== "string" && typeof raw !== "number") { issues.push(`${field}: must be a name or ID`); continue; }
        references = [String(raw).trim()];
      }
      const ids: string[] = [];
      for (const reference of references) {
        const result = this.resolve(spec.type, reference);
        if (result.status === "resolved") { if (!ids.includes(result.id)) ids.push(result.id); }
        else unresolved.push({ field, reference, problem: result.status, candidates: result.candidates });
      }
      if (spec.list) { if (ids.length) links[spec.linkField] = ids; }
      else if (ids[0]) links[spec.linkField] = ids[0];
    }
    return { issues, links, unresolved };
  }

  /** Maps each subject to an existing one that is equal after case/accent/separator folding; drops repeats. */
  normaliseSubjects(subjects: string[]) {
    const known = new Map<string, string>();
    for (const object of this.ctx.index.all()) {
      if (!isLive(object)) continue;
      for (const subject of object.frontmatter.subjects ?? []) if (!known.has(foldSubject(subject))) known.set(foldSubject(subject), subject);
    }
    const result: string[] = [];
    for (const subject of subjects.map((item) => item.trim()).filter(Boolean)) {
      const chosen = known.get(foldSubject(subject)) ?? subject;
      known.set(foldSubject(subject), chosen);
      if (!result.includes(chosen)) result.push(chosen);
    }
    return result;
  }

  /**
   * Writes one pending `link-resolution` Review Item per unresolved reference on `target`; returns their IDs.
   * `newId` (adoption's `run.newId`) makes the IDs replayable after a crash, keyed by the reference (#59); it
   * defaults to fresh UUIDv7s.
   */
  async raiseLinkReviews(target: LifeOSObject["frontmatter"], unresolved: UnresolvedReference[], context: { now: string; origin: Origin; agentRunId?: string; sourceIds?: string[]; newId?: (role: ReplayRole) => string }) {
    const ids: string[] = [];
    const newId = context.newId ?? (() => uuidV7());
    for (const item of unresolved) {
      const spec = referenceFields[item.field];
      const role = replayRoles.link(item.field, item.reference);
      const title = `Link ${item.field.replace("_", " ")} "${item.reference}" on ${target.title}`;
      const why = item.problem === "ambiguous" ? `matches ${item.candidates.length} ${spec.type}s:\n\n${item.candidates.map((candidate) => `- ${candidate.title} (${candidate.id})`).join("\n")}` : `matches no ${spec.type}.`;
      const { frontmatter: { id } } = await proposeReviewItem(this.ctx, { now: context.now, agentRunId: context.agentRunId, newId }, {
        role, reviewType: "link-resolution", title, target: { type: target.type, id: target.id }, origin: context.origin, confidence: "Low", sourceIds: context.sourceIds,
        // The target may not be in the index yet (adoption creates it just before), so its own sensitivity is passed too.
        ...(target.sensitivity === "restricted" ? { sensitivity: target.sensitivity } : {}),
        proposed: { reference_field: item.field, reference: item.reference, link_field: spec.linkField, list: spec.list, candidate_type: spec.type, problem: item.problem, candidates: item.candidates },
        body: `# ${title}\n\n"${item.reference}" ${why}\n`
      });
      ids.push(id);
    }
    return ids;
  }
}
