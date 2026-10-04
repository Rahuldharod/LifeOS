// Origin, sensitivity and Area on the Object Envelope (#30, ADR 0010). Labels mirror packages/domain,
// which the browser bundle does not import; the server enforces the rules.
import { isRestricted } from "@lifeos/shared";

/** The restricted rule, shared with the server (#75). */
export { isRestricted };

export const areaOptions = ["work", "maintenance", "household", "learning", "personal-projects", "personal-growth"] as const;

const originLabels: Record<string, string> = { app: "LifeOS app", "user-dictated": "Dictated by you", "agent-extracted": "Extracted by an agent", calendar: "Calendar", imported: "Imported", external: "External edit" };

/** Objects without an origin were made in the app before #30, so they read as `app`. */
export function originLabel(frontmatter: Record<string, unknown>) {
  const origin = typeof frontmatter.origin === "string" ? frontmatter.origin : "app";
  return originLabels[origin] ?? origin;
}
