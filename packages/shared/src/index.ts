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
