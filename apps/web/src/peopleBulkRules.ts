// People settings filters and bulk actions (#230).
// Pure rules, so the card and the tests share them: which people a filter shows, and which selected
// people an action applies to (the others are skipped and counted, never sent to the server).
import type { LifeObject, PersonLabel } from "@lifeos/contracts";
import { isUnreviewedPerson } from "@lifeos/shared";
import { externalChoiceOf } from "./personLabels.js";

export type PeopleFilters = {
  review: "all" | "unreviewed" | "reviewed";
  side: "all" | "internal" | "external";
  /** "Not a person" People are archived; this filter is the only place the list shows them. */
  kind: "person" | "not-a-person" | "all";
};
export const defaultPeopleFilters: PeopleFilters = { review: "all", side: "all", kind: "person" };
export const filtersActive = (filters: PeopleFilters) => filters.review !== "all" || filters.side !== "all" || filters.kind !== defaultPeopleFilters.kind;

const isNotAPerson = (person: LifeObject) => person.frontmatter.not_a_person === true;

/** Every filter must match (AND). Internal/External is the label LifeOS shows, so Auto follows the email domain. */
export function matchesPeopleFilters(person: LifeObject, labels: Map<string, PersonLabel>, filters: PeopleFilters): boolean {
  if (filters.kind === "person" && isNotAPerson(person)) return false;
  if (filters.kind === "not-a-person" && !isNotAPerson(person)) return false;
  const unreviewed = isUnreviewedPerson(person.frontmatter);
  if (filters.review === "unreviewed" && !unreviewed) return false;
  if (filters.review === "reviewed" && unreviewed) return false;
  const external = labels.get(person.frontmatter.id)?.isExternal === true;
  if (filters.side === "internal" && external) return false;
  if (filters.side === "external" && !external) return false;
  return true;
}

export type PeopleBulkAction = "internal" | "external" | "person" | "not-a-person" | "confirm" | "archive" | "delete";
export const bulkActionLabels: Record<PeopleBulkAction, string> = {
  internal: "Mark internal", external: "Mark external", person: "Mark as a person", "not-a-person": "Mark as not a person",
  confirm: "Confirm", archive: "Archive…", delete: "Delete…"
};
/** Past tense for the result line: "3 marked internal". */
export const bulkActionDone: Record<PeopleBulkAction, string> = {
  internal: "marked internal", external: "marked external", person: "marked as a person", "not-a-person": "marked as not a person",
  confirm: "confirmed", archive: "archived", delete: "deleted"
};

/** Whether the action changes this person. You are never changed in bulk; a person already in the target state is skipped. */
export function bulkApplies(action: PeopleBulkAction, person: LifeObject): boolean {
  if (person.frontmatter.is_self === true) return false;
  switch (action) {
    case "internal": return externalChoiceOf(person.frontmatter) !== "internal";
    case "external": return externalChoiceOf(person.frontmatter) !== "external";
    case "person": return isNotAPerson(person);
    case "not-a-person": return !isNotAPerson(person);
    case "confirm": return isUnreviewedPerson(person.frontmatter);
    case "archive": return !person.frontmatter.archived_at;
    case "delete": return true;
  }
}

export type BulkResult = { action: PeopleBulkAction; done: number; skipped: number; failed: Array<{ title: string; error: string }> };

/**
 * One write per person, one after the other (each guarded by that person's content hash). A failure is
 * recorded and the rest carry on; every endpoint used is idempotent, so running the action again is safe.
 */
export async function applyToEach(action: PeopleBulkAction, people: LifeObject[], write: (person: LifeObject) => Promise<unknown>, onProgress?: (done: number, total: number) => void): Promise<BulkResult> {
  const targets = people.filter((person) => bulkApplies(action, person));
  const result: BulkResult = { action, done: 0, skipped: people.length - targets.length, failed: [] };
  for (const person of targets) {
    try { await write(person); result.done += 1; }
    catch (error) { result.failed.push({ title: String(person.frontmatter.title), error: error instanceof Error ? error.message : "Something went wrong" }); }
    onProgress?.(result.done + result.failed.length, targets.length);
  }
  return result;
}

const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;
/** "3 people marked internal · 1 skipped (already done or not allowed) · 1 failed". */
export function describeBulkResult(result: BulkResult): string {
  const parts = [`${people(result.done)} ${bulkActionDone[result.action]}`];
  if (result.skipped) parts.push(`${result.skipped} skipped (already done, or not allowed for you)`);
  if (result.failed.length) parts.push(`${result.failed.length} failed`);
  return parts.join(" · ");
}
