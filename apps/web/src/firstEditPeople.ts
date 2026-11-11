// People on a Meeting Note before and at its first edit.

interface Option { id: string }
interface Attendee { frontmatter: { id: string } }

/**
 * The header People of a note that does not exist yet: every Attendee LifeOS already knows, matched by id.
 * Attendees LifeOS does not know yet carry a preview id, match no option and stay blank until the first edit creates them.
 */
export function headerPeopleIds(options: readonly Option[], attendees: readonly Attendee[]) {
  return attendees.map((person) => person.frontmatter.id).filter((id) => options.some((option) => option.id === id));
}

/**
 * The People to save at the first edit when the user changed them before typing: what they picked, plus the Attendees
 * the first edit just created (the header could not show those). Known Attendees were shown, so the user's pick decides them.
 */
export function firstEditPeopleIds(picked: readonly string[], created: readonly string[], options: readonly Option[]) {
  return [...new Set([...picked, ...created.filter((id) => !options.some((option) => option.id === id))])];
}
