// Display labels for people (#39). The server computes them (`GET /api/v1/people/labels`); the web
// only looks them up and falls back to the title for a person the labels do not know yet.
import type { SearchOption } from "./searchOptions.js";

export type PersonLabel = { id: string; name: string; label: string; suffix?: string; isExternal: boolean; externalSource: "self" | "override" | "email" | "stored"; unreviewed?: boolean };
type PersonLike = { frontmatter: { id: string; title: string } };

export const labelMap = (labels: PersonLabel[]) => new Map(labels.map((label) => [label.id, label]));

/** The label for a person, or a plain stand-in built from the title (for example an unsaved attendee preview). */
export function personLabel(labels: Map<string, PersonLabel>, person: PersonLike): Pick<PersonLabel, "name" | "label" | "suffix" | "unreviewed"> {
  return labels.get(person.frontmatter.id) ?? { name: person.frontmatter.title, label: person.frontmatter.title };
}

/** Picker option: the short name as the searchable title, with the " - ext" suffix carried separately so it can be styled. */
export function personOption(labels: Map<string, PersonLabel>, person: PersonLike): SearchOption {
  const { name, suffix } = personLabel(labels, person);
  return { id: person.frontmatter.id, title: name, ...(suffix ? { suffix } : {}) };
}

/** "example.com, example.org\nacme.fr" → ["example.com", "example.org", "acme.fr"]; the server validates. */
export const parseDomains = (text: string) => text.split(/[\s,;]+/).map((domain) => domain.trim()).filter(Boolean);
/** "me@example.com, me@example.org" → ["me@example.com", "me@example.org"] (#54); the server lowercases and validates. */
export const parseEmails = parseDomains;

/** The External choice shown on a person card: Auto follows the email domain rule. */
export type ExternalChoice = "auto" | "external" | "internal";
export const externalChoiceValue = (choice: ExternalChoice) => choice === "auto" ? null : choice === "external";
export const externalChoiceOf = (frontmatter: Record<string, unknown>): ExternalChoice => frontmatter.is_external_override === true ? "external" : frontmatter.is_external_override === false ? "internal" : "auto";
