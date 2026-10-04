export const LIFEOS_SCHEMA_VERSION = 1;

// Rules both the server and the browser bundle need (#75). This package has no Node dependencies, so the web app
// can import it; @lifeos/domain cannot be (it uses node:crypto).

/** The context links an object carries: its primary project, client and product. */
export const contextLinkFields = ["primary_project_id", "primary_client_id", "primary_product_id"] as const;

/** ADR 0010: restricted only when `sensitivity: restricted`; missing or any other value means normal. */
export function isRestricted(frontmatter: { sensitivity?: unknown } | Record<string, unknown>) {
  return (frontmatter as { sensitivity?: unknown }).sensitivity === "restricted";
}
