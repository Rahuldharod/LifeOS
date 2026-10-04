// `lifeos://object/<id>` links point at a LifeOS object (PB-007). This decides where a click goes:
// which view shows the object, or why it cannot be opened.

export type LinkedObject = { frontmatter: { id: string; type: string; title: string; deleted_at?: unknown; archived_at?: unknown } };

export type LinkTarget =
  | { kind: "note"; id: string; deleted: boolean }
  | { kind: "meeting"; id: string }
  | { kind: "entity"; id: string; view: "Tasks" | "Projects" | "Clients" | "Products" | "People" | "Decisions" }
  | { kind: "inbox"; id: string }
  | { kind: "unsupported"; id: string; type: string }
  | { kind: "missing"; id: string }
  | { kind: "invalid" };

const LINK = /^lifeos:\/\/object\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#].*)?$/i;

/** The object id inside a `lifeos://object/...` link, or undefined for any other href. */
export function lifeosLinkId(href: string | null | undefined): string | undefined {
  return href ? LINK.exec(href.trim())?.[1]?.toLowerCase() : undefined;
}

const entityViews: Record<string, "Tasks" | "Projects" | "Clients" | "Products" | "People" | "Decisions"> = { task: "Tasks", project: "Projects", client: "Clients", product: "Products", person: "People", decision: "Decisions" };

export function resolveLifeosLink(href: string, objects: LinkedObject[]): LinkTarget {
  const id = lifeosLinkId(href);
  if (!id) return { kind: "invalid" };
  const object = objects.find((candidate) => candidate.frontmatter.id.toLowerCase() === id);
  if (!object) return { kind: "missing", id };
  const { type } = object.frontmatter;
  if (type === "meeting-note" || type === "knowledge-note") return { kind: "note", id, deleted: Boolean(object.frontmatter.deleted_at) };
  if (object.frontmatter.deleted_at || object.frontmatter.archived_at) return { kind: "missing", id };
  if (type === "meeting") return { kind: "meeting", id };
  if (type === "review-item") return { kind: "inbox", id };
  const view = entityViews[type];
  return view ? { kind: "entity", id, view } : { kind: "unsupported", id, type };
}
