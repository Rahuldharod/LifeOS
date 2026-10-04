import type { IndexStore } from "@lifeos/application";
import type { LifeOSObject } from "@lifeos/domain";

export class MemoryIndex implements IndexStore {
  private objects = new Map<string, LifeOSObject>();
  private issues: string[] = [];

  rebuild(objects: LifeOSObject[], diagnostics: string[] = []) {
    this.objects.clear();
    this.issues = [...diagnostics];
    for (const object of objects) {
      const id = object.frontmatter.id;
      if (this.objects.has(id)) this.issues.push(`Duplicate object ID: ${id}`);
      else this.objects.set(id, object);
    }
    this.validateGraph();
  }

  all() { return [...this.objects.values()]; }
  get(id: string) { return this.objects.get(id); }
  diagnostics() { return [...this.issues]; }
  backlinks(id: string) {
    return this.all().filter((object) => Object.entries(object.frontmatter).some(([field, value]) =>
      field.endsWith("_id") && value === id || field.endsWith("_ids") && Array.isArray(value) && value.includes(id)));
  }
  search(query: string) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return this.all();
    return this.all().filter((object) => `${object.frontmatter.title}\n${object.body}`.toLocaleLowerCase().includes(needle));
  }

  private validateGraph() {
    const all = [...this.objects.values()];
    const selfPeople = all.filter((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true);
    const located = (id: string) => `${this.objects.get(id)?.relativePath ?? "?"} (id ${id})`;
    if (selfPeople.length > 1) this.issues.push(`Multiple self people configured: ${selfPeople.map((person) => located(person.frontmatter.id)).join(", ")}`);

    const notesByMeeting = new Map<string, string[]>();
    for (const object of all) {
      if (object.frontmatter.type === "meeting-note" && typeof object.frontmatter.meeting_id === "string" && !object.frontmatter.archived_at) {
        const notes = notesByMeeting.get(object.frontmatter.meeting_id) ?? [];
        notes.push(object.frontmatter.id);
        notesByMeeting.set(object.frontmatter.meeting_id, notes);
      }
      this.validateReferences(object);
    }
    for (const [meetingId, noteIds] of notesByMeeting) {
      if (noteIds.length > 1) this.issues.push(`Meeting ${meetingId} has multiple canonical notes: ${noteIds.map(located).join(", ")}`);
    }
    const externalRefs = new Map<string, string>();
    // Archived objects (e.g. a reconciled duplicate meeting, PB-004) no longer claim their external id.
    for (const object of all.filter((candidate) => !candidate.frontmatter.archived_at)) {
      const refs = Array.isArray(object.frontmatter.external_refs) ? object.frontmatter.external_refs : [];
      for (const raw of refs) {
        if (!raw || typeof raw !== "object") continue;
        const reference = raw as Record<string, unknown>;
        if (typeof reference.provider !== "string" || typeof reference.external_id !== "string") continue;
        const key = `${reference.provider}:${reference.external_id}`;
        const prior = externalRefs.get(key);
        if (prior && prior !== object.frontmatter.id) this.issues.push(`Duplicate external reference ${key}: ${located(prior)}, ${located(object.frontmatter.id)}`);
        else externalRefs.set(key, object.frontmatter.id);
      }
    }
  }

  private validateReferences(object: LifeOSObject) {
    const expectedTypes: Record<string, string> = {
      meeting_id: "meeting", source_meeting_id: "meeting", owner_person_id: "person",
      waiting_for_person_id: "person", organizer_person_id: "person", primary_client_id: "client",
      primary_product_id: "product", primary_project_id: "project", resolution_decision_id: "decision",
      supersedes_decision_id: "decision", connector_account_id: "connector-account", agent_run_id: "agent-run"
    };
    const singleFields = [...Object.keys(expectedTypes), "resolved_object_id", "asset_id", "avatar_asset_id"];
    const listFields = ["attendee_ids", "people_ids", "source_ids", "dependency_ids", "related_object_ids"];

    for (const field of singleFields) {
      const value = object.frontmatter[field];
      if (typeof value === "string") this.validateReference(object, field, value, expectedTypes[field]);
    }
    for (const field of listFields) {
      const value = object.frontmatter[field];
      if (!Array.isArray(value)) continue;
      for (const id of value) if (typeof id === "string") this.validateReference(object, field, id, field === "attendee_ids" || field === "people_ids" ? "person" : field === "dependency_ids" ? "task" : undefined);
    }
  }

  private validateReference(source: LifeOSObject, field: string, targetId: string, expectedType?: string) {
    const target = this.objects.get(targetId);
    if (!target) {
      this.issues.push(`${source.relativePath} (id ${source.frontmatter.id}): ${field} references missing object ${targetId}`);
      return;
    }
    if (expectedType && target.frontmatter.type !== expectedType) {
      this.issues.push(`${source.relativePath} (id ${source.frontmatter.id}): ${field} expects ${expectedType}, found ${target.frontmatter.type} (${target.relativePath})`);
    }
  }
}
