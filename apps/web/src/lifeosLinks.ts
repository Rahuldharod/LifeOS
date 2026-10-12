// `lifeos://object/<id>` links point at a LifeOS object (PB-007). This decides where a click goes:
// which view shows the object, or why it cannot be opened.

export type LinkedObject = { frontmatter: { id: string; type: string; title: string; deleted_at?: unknown; archived_at?: unknown; redirect_to_note_id?: unknown; redirect_to_meeting_id?: unknown; redirect_to_section_id?: unknown } };

export type LinkTarget =
  | { kind: "note"; id: string; deleted: boolean }
  | { kind: "meeting"; id: string }
  | { kind: "entity"; id: string; view: "Tasks" | "Projects" | "Clients" | "Products" | "People" | "Decisions" | "Open Points" }
  | { kind: "inbox"; id: string }
  | { kind: "unsupported"; id: string; type: string }
  | { kind: "missing"; id: string }
  | { kind: "invalid" };

const LINK = /^lifeos:\/\/object\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#].*)?$/i;

/** The object id inside a `lifeos://object/...` link, or undefined for any other href. */
export function lifeosLinkId(href: string | null | undefined): string | undefined {
  return href ? LINK.exec(href.trim())?.[1]?.toLowerCase() : undefined;
}

const entityViews: Record<string, "Tasks" | "Projects" | "Clients" | "Products" | "People" | "Decisions" | "Open Points"> = { task: "Tasks", project: "Projects", client: "Clients", product: "Products", person: "People", decision: "Decisions", "open-point": "Open Points" };

export function resolveLifeosLink(href: string, objects: LinkedObject[]): LinkTarget {
  const id = lifeosLinkId(href);
  if (!id) return { kind: "invalid" };
  const object = objects.find((candidate) => candidate.frontmatter.id.toLowerCase() === id);
  if (!object) return { kind: "missing", id };
  const { type } = object.frontmatter;
  if (type === "meeting-note" || type === "knowledge-note") return { kind: "note", id, deleted: Boolean(object.frontmatter.deleted_at) };
  // #118: an explicit ID still opens an archived object, so old links keep working; only a deleted one is gone.
  if (object.frontmatter.deleted_at) return { kind: "missing", id };
  if (type === "meeting") return { kind: "meeting", id };
  if (type === "review-item") return { kind: "inbox", id };
  const view = entityViews[type];
  return view ? { kind: "entity", id, view } : { kind: "unsupported", id, type };
}

/**
 * #118: tab lists hold live objects only, but a link still opens an archived one. Returns `list` plus the
 * archived (not deleted) object `id` of `type` from `all` when the list lacks it; otherwise `list` unchanged.
 */
export function withOpenedArchived<T extends LinkedObject>(list: T[], all: LinkedObject[], type: string, id?: string): T[] {
  if (!id || list.some((object) => object.frontmatter.id === id)) return list;
  const opened = all.find((object) => object.frontmatter.id === id);
  if (!opened || opened.frontmatter.type !== type || opened.frontmatter.deleted_at || !opened.frontmatter.archived_at) return list;
  return [...list, opened as T];
}
