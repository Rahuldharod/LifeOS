import { entityLinkFields, type EntityType } from "@lifeos/shared";
import type { AppContext } from "./context.js";

/**
 * Checks and normalises the relationship fields of an entity write (PB-010), in place on `selected`.
 * A new link must point at a live object of the right type (not deleted, not archived), as note
 * links do. A link already stored on the object is kept even when its target has since been
 * archived or deleted, so saving other fields never drops it. `null` or "" clears an optional link.
 */
export function checkEntityLinks(ctx: AppContext, type: EntityType, selected: Record<string, unknown>, previous?: Record<string, unknown>) {
  const live = (id: unknown, target: EntityType, label: string) => {
    const object = typeof id === "string" ? ctx.index.get(id) : undefined;
    if (!object || object.frontmatter.type !== target || object.frontmatter.deleted_at || object.frontmatter.archived_at) throw new Error(`${label} not found`);
  };
  for (const field of entityLinkFields[type]) {
    if (!(field.key in selected)) continue;
    const value = selected[field.key];
    // A list entry names the object type ("Task not found"); a single link names its field ("Owner not found").
    const label = field.multi ? field.target[0]!.toUpperCase() + field.target.slice(1) : field.label;
    if (value === null || value === "" || value === undefined) {
      if (field.required) throw new Error(`${field.label} is required`);
      selected[field.key] = undefined;
      continue;
    }
    if (field.multi) {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${field.label} must be a list of ids`);
      const kept = Array.isArray(previous?.[field.key]) ? previous[field.key] as unknown[] : [];
      const ids = [...new Set(value as string[])];
      ids.filter((id) => !kept.includes(id)).forEach((id) => live(id, field.target, label));
      selected[field.key] = ids.length ? ids : undefined;
      continue;
    }
    if (typeof value !== "string") throw new Error(`${field.label} must be an id`);
    if (value !== previous?.[field.key]) live(value, field.target, label);
  }
}
