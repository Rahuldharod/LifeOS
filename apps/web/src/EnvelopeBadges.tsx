// Shows where an object came from and a lock badge when it is restricted (#30). The badge says
// "Restricted" in words, so it does not rely on colour alone.
import React from "react";
import { isRestricted, originLabel } from "./envelope.js";

export function LockBadge({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  return isRestricted(frontmatter) ? <span className="lock-badge" title="Restricted: kept away from Agents, Daily Focus, Work Orders and Slack"><span aria-hidden>🔒</span> Restricted</span> : null;
}

/** `lock={false}` leaves the lock badge to a SensitivityToggle shown nearby (#86), so it is not shown twice. */
export function EnvelopeBadges({ frontmatter, lock = true }: { frontmatter: Record<string, unknown>; lock?: boolean }) {
  return <span className="envelope-badges"><small className="origin-label">Origin: {originLabel(frontmatter)}</small>{lock && <LockBadge frontmatter={frontmatter} />}</span>;
}
