export const LIFEOS_SCHEMA_VERSION = 1;

// Rules both the server and the browser bundle need (#75). This package has no Node dependencies, so the web app
// can import it; @lifeos/domain cannot be (it uses node:crypto).

/** The context links an object carries: its primary project, client and product. */
export const contextLinkFields = ["primary_project_id", "primary_client_id", "primary_product_id"] as const;

export type EntityType = "task" | "project" | "client" | "product" | "person";
/** One relationship field on an entity form (PB-010): `target` is the linked object type; `multi` fields hold a list of ids. */
export type EntityLinkField = { key: string; label: string; target: EntityType; multi?: boolean; required?: boolean };

/**
 * The relationship fields of the Tasks, Projects, Clients, Products and People forms (PB-010). The
 * server validates new links against this list and the web form draws a searchable picker for each.
 */
export const entityLinkFields: Record<EntityType, EntityLinkField[]> = {
  task: [
    { key: "owner_person_id", label: "Owner", target: "person", required: true },
    { key: "waiting_for_person_id", label: "Waiting for", target: "person" },
    { key: "primary_project_id", label: "Project", target: "project" },
    { key: "primary_client_id", label: "Client", target: "client" },
    { key: "primary_product_id", label: "Product", target: "product" },
    { key: "dependency_ids", label: "Depends on", target: "task", multi: true }
  ],
  project: [
    { key: "owner_person_id", label: "Owner", target: "person" },
    { key: "primary_client_id", label: "Client", target: "client" },
    { key: "primary_product_id", label: "Product", target: "product" }
  ],
  client: [{ key: "primary_contact_person_id", label: "Primary contact", target: "person" }],
  product: [{ key: "owner_person_id", label: "Owner", target: "person" }],
  person: []
};

/** ADR 0010: restricted only when `sensitivity: restricted`; missing or any other value means normal. */
export function isRestricted(frontmatter: { sensitivity?: unknown } | Record<string, unknown>) {
  return (frontmatter as { sensitivity?: unknown }).sensitivity === "restricted";
}

/** App-managed recurring-occurrence material markers shared by persistence and the browser editor. */
export const occurrenceMaterialsStart = (sectionId: string) => `<!-- lifeos:materials:start ${sectionId} -->`;
export const occurrenceMaterialsEnd = (sectionId: string) => `<!-- lifeos:materials:end ${sectionId} -->`;

export function occurrenceMaterialsBlock(markdown: string, sectionId: string) {
  const start = occurrenceMaterialsStart(sectionId);
  const end = occurrenceMaterialsEnd(sectionId);
  const from = markdown.indexOf(start);
  const to = from < 0 ? -1 : markdown.indexOf(end, from + start.length);
  return from >= 0 && to >= 0 ? markdown.slice(from, to + end.length) : "";
}

/** The Summary section of a meeting body is fenced by these markers (#66). */
export const summaryStartMarker = "<!-- lifeos:summary:start -->";
export const summaryEndMarker = "<!-- lifeos:summary:end -->";

/** The accepted summary text inside the markers, without its heading; empty when the body has no marked summary (#176). */
export function acceptedSummaryText(body: string) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === summaryStartMarker);
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.trim() === summaryEndMarker);
  if (end < 0) return "";
  return lines.slice(start + 1, end).join("\n").replace(/^\s*##\s+Summary\s*\n/i, "").trim();
}
