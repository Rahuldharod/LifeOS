// Form state for editing a note's title and relationships (PB-006), and the minimal change set
// sent to the server. Sending only what moved keeps a rename from overwriting a relationship that
// the other device just changed.

export type NoteDetailsForm = { title: string; projectId: string; clientId: string; productId: string; peopleIds: string[] };

type NoteFrontmatter = Record<string, unknown> & { title: string; type: string };

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function noteDetailsForm(frontmatter: NoteFrontmatter): NoteDetailsForm {
  return {
    title: frontmatter.title,
    projectId: text(frontmatter.primary_project_id),
    clientId: text(frontmatter.primary_client_id),
    productId: text(frontmatter.primary_product_id),
    peopleIds: Array.isArray(frontmatter.people_ids) ? frontmatter.people_ids.filter((id): id is string => typeof id === "string") : []
  };
}

/** Fields that differ from the saved note. An empty selection becomes `null`, which clears the link. */
export function noteDetailsChanges(frontmatter: NoteFrontmatter, form: NoteDetailsForm): Record<string, unknown> {
  const saved = noteDetailsForm(frontmatter);
  const changes: Record<string, unknown> = {};
  if (form.title.trim() !== saved.title) changes.title = form.title.trim();
  if (form.projectId !== saved.projectId) changes.primary_project_id = form.projectId || null;
  if (form.clientId !== saved.clientId) changes.primary_client_id = form.clientId || null;
  if (form.productId !== saved.productId) changes.primary_product_id = form.productId || null;
  if (frontmatter.type === "meeting-note" && [...form.peopleIds].sort().join() !== [...saved.peopleIds].sort().join()) changes.people_ids = form.peopleIds;
  return changes;
}
