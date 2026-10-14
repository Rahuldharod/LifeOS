// #87: people created automatically (calendar invites, adopted drafts) stay "unreviewed" (PRD story 72)
// until the user saves or confirms them. The marker is text, so it is read out and never relies on colour.
import React from "react";
import { isUnreviewedPerson } from "@lifeos/shared";

export function UnreviewedMarker({ unreviewed }: { unreviewed?: boolean }) {
  return unreviewed ? <span className="unreviewed-marker" title="Created automatically; confirm or save to review"> · unreviewed</span> : null;
}

type PersonLike = { frontmatter: { id: string; title: string; review_state?: unknown; origin?: unknown; is_self?: unknown } };

/** On the People card: the marker, where the person came from, and a Confirm button. Nothing once reviewed. */
export function PersonReviewControl({ person, disabled, onConfirm }: { person: PersonLike; disabled: boolean; onConfirm: (person: PersonLike) => void }) {
  if (!isUnreviewedPerson(person.frontmatter)) return null;
  const from = person.frontmatter.origin === "calendar" ? "created from a calendar invite" : "created automatically from an inbox draft";
  return <span className="person-review"><b>Unreviewed</b><small>{from}</small>
    <button type="button" aria-label={`Confirm ${person.frontmatter.title} as reviewed`} disabled={disabled} onClick={() => onConfirm(person)}>Confirm</button></span>;
}
