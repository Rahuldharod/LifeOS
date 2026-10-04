// Link-resolution Review Items (#33, card #57): a name that matched zero or several objects. The card
// lists the candidates by display label, and accepting sends the chosen one as `linkTo`.
import { personLabel, type PersonLabel } from "./personLabels.js";

type ReviewLike = { frontmatter: { id: string; title: string } & Record<string, unknown> };
type Proposal = { reference_field?: unknown; reference?: unknown; candidate_type?: unknown; problem?: unknown; candidates?: unknown };
/** One pickable candidate: the short name, plus the " - ext" marker for external people (styled separately). */
export type LinkOption = { id: string; name: string; suffix?: string };
/** `api` from ./api.js, passed in so the requests can be tested without a server. */
export type ApiCall = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Types the entities route can create (`POST /api/v1/entities/:type`); meetings come from the calendar. */
const creatable = ["person", "project", "client", "product"];
const plural: Record<string, string> = { person: "people" };
const pluralOf = (type: string) => plural[type] ?? `${type}s`;

export function linkResolutionView(review: ReviewLike, labels: Map<string, PersonLabel>) {
  const proposed = (review.frontmatter.proposed_fields ?? {}) as Proposal;
  const reference = typeof proposed.reference === "string" ? proposed.reference : "";
  const candidateType = typeof proposed.candidate_type === "string" ? proposed.candidate_type : "";
  const field = typeof proposed.reference_field === "string" ? proposed.reference_field : "";
  const candidates = Array.isArray(proposed.candidates)
    ? (proposed.candidates as unknown[]).filter((item): item is { id: string; title: string } => typeof (item as { id?: unknown })?.id === "string" && typeof (item as { title?: unknown }).title === "string")
    : [];
  const options: LinkOption[] = candidates.map((candidate) => {
    if (candidateType !== "person") return { id: candidate.id, name: candidate.title };
    const { name, suffix } = personLabel(labels, { frontmatter: candidate });
    return { id: candidate.id, name, ...(suffix ? { suffix } : {}) };
  });
  const explanation = options.length
    ? `"${reference}" matches ${options.length} ${options.length === 1 ? candidateType : pluralOf(candidateType)}. Choose the one you meant.`
    : `No ${candidateType || "object"} matches "${reference}".`;
  return {
    reference, candidateType, options, explanation,
    fieldLabel: field.replace(/_/g, " "),
    problem: proposed.problem === "ambiguous" ? "ambiguous" as const : "unknown" as const,
    canCreate: creatable.includes(candidateType) && reference.trim() !== ""
  };
}

const typeLabel = (type: string) => { const words = type.replace(/-/g, " "); return words.charAt(0).toUpperCase() + words.slice(1); };

/** The success message after accepting a Review Item, by item type. */
export function acceptToast(frontmatter: Record<string, unknown>) {
  switch (frontmatter.review_type) {
    case "link-resolution": return "Link saved";
    case "person-merge": return "People merged";
    case "update": return "Change applied";
    case "summary": return "Summary added to the meeting";
    default: return `${typeLabel(String(frontmatter.target_object_type ?? "task"))} accepted and published`;
  }
}

/** Accepts a link-resolution item, linking the chosen candidate. */
export const acceptLink = (call: ApiCall, reviewId: string, linkTo: string) =>
  call<unknown>(`/api/v1/review-items/${reviewId}/accept`, { method: "POST", body: JSON.stringify({ linkTo }) });

/** Creates the missing object, titled with the unresolved text, so it can then be linked. */
export async function createLinkTarget(call: ApiCall, type: string, title: string): Promise<LinkOption> {
  const created = await call<{ frontmatter: { id: string; title: string } }>(`/api/v1/entities/${type}`, { method: "POST", body: JSON.stringify({ fields: { title } }) });
  return { id: created.frontmatter.id, name: created.frontmatter.title };
}
