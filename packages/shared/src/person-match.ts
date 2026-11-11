// Person matching rules shared by the server's merge suggestions and maintenance scripts (#212, reused by #215).
// Pure and free of Node dependencies.

/** Lowercase and strip accents so "Zoé" matches "zoe". */
export const foldForSearch = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The ways an email local part can spell a name: `john.doe`, `johndoe`, `john_doe`, or `jdoe` (first initial + family name). */
export type EmailNameMatchKind = "first.last" | "firstlast" | "first_last" | "flast";

/**
 * Why two People look like the same person. `first-name` (a one-word name fitting exactly one full name) is offered only
 * by the Duplicate clean-up, never by the background suggestions; `manual` is the user's own merge.
 */
export type PersonMergeMatch = "email" | "name-address" | "email-local-part" | "name" | "name-email" | "first-name" | "manual";

/** A live person as the matcher sees them: every name they are known by (title, given + family name, aliases). */
export interface NameCandidate { id: string; names: readonly string[] }

/** Origins of people LifeOS creates by itself; a person from one of them is unreviewed until the user confirms it. */
const automaticOrigins = new Set(["calendar", "agent-extracted"]);

/**
 * A person LifeOS created automatically (calendar or agent) and the user has not confirmed. An explicit review_state wins;
 * people created from an attendee name alone carry no review state, so their origin decides. People the user creates are never unreviewed.
 */
export function isUnreviewedPerson(frontmatter: Readonly<Record<string, unknown>>): boolean {
  if (frontmatter.is_self === true) return false;
  if (frontmatter.review_state === "unreviewed") return true;
  return frontmatter.review_state === undefined && typeof frontmatter.origin === "string" && automaticOrigins.has(frontmatter.origin);
}

const letters = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, "");
const localPartOf = (email: string) => foldForSearch(email.trim()).split("@")[0]!.replace(/\+.*$/, "");

/** First and family name from a full name: the first and last word; hyphenated family names may be written with or without the hyphen. */
function namePieces(name: string) {
  const words = foldForSearch(name).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return undefined;
  const first = letters(words[0]!), family = words[words.length - 1]!;
  return first && letters(family) ? { first, families: [...new Set([family, letters(family)])] } : undefined;
}

/** How an email's local part fits one name, ignoring the `flast` uniqueness rule (see {@link emailNameMatch}). */
export function emailFitsName(email: string, name: string): EmailNameMatchKind | undefined {
  const local = localPartOf(email), pieces = namePieces(name);
  if (!local || !pieces) return undefined;
  for (const family of pieces.families) {
    if (local === `${pieces.first}.${family}`) return "first.last";
    if (local === `${pieces.first}${family}`) return "firstlast";
    if (local === `${pieces.first}_${family}`) return "first_last";
  }
  return pieces.families.some((family) => local === `${pieces.first[0]}${family}`) ? "flast" : undefined;
}

/**
 * How an email address fits a person's name, or undefined. `first.last`, `firstlast` and `first_last` fit on their own;
 * `flast` (john doe → jdoe) fits only when exactly one of `live` people (the candidate included) fits it, so a shared
 * initial and family name never links the wrong people.
 */
export function emailNameMatch(email: string, person: NameCandidate, live: readonly NameCandidate[]): EmailNameMatchKind | undefined {
  const kinds = person.names.map((name) => emailFitsName(email, name));
  const exact = kinds.find((kind) => kind !== undefined && kind !== "flast");
  if (exact) return exact;
  if (!kinds.includes("flast")) return undefined;
  const fitting = live.filter((other) => other.names.some((name) => emailFitsName(email, name) === "flast"));
  return fitting.length === 1 && fitting[0]!.id === person.id ? "flast" : undefined;
}
