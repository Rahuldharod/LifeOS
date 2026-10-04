import type { ObjectEnvelope } from "@lifeos/domain";
import { foldForSearch, type AppContext } from "./context.js";

const noteTypes = ["meeting-note", "knowledge-note"];

/** Meeting and knowledge notes: listing, search, body and metadata edits, delete and restore. */
export class NotesModule {
  constructor(private readonly ctx: AppContext) {}

  notes() {
    return this.ctx.index.all()
      .filter((object) => noteTypes.includes(object.frontmatter.type) && !object.frontmatter.deleted_at && !object.frontmatter.archived_at)
      .sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at));
  }

  /** Tombstoned notes (PB-021), most recently deleted first. */
  deletedNotes() {
    return this.ctx.index.all()
      .filter((object) => noteTypes.includes(object.frontmatter.type) && object.frontmatter.deleted_at && !object.frontmatter.archived_at)
      .sort((left, right) => Date.parse(String(right.frontmatter.deleted_at)) - Date.parse(String(left.frontmatter.deleted_at)));
  }

  /**
   * Keyword search over the in-memory index (PB-025): a note matches when every word of `query`
   * appears in its title or body, ignoring case and accents. It never touches the filesystem, so
   * cost depends on the notes already loaded, not on the folder. A blank query returns the whole tab.
   */
  searchNotes(query: string, state: "open" | "deleted" = "open") {
    const notes = state === "deleted" ? this.deletedNotes() : this.notes();
    const words = foldForSearch(query).split(/\s+/).filter(Boolean);
    if (!words.length) return notes;
    return notes.filter((note) => {
      const text = foldForSearch(`${note.frontmatter.title}\n${note.body}`);
      return words.every((word) => text.includes(word));
    });
  }

  async updateBody(id: string, body: string, expectedHash: string) {
    const current = this.ctx.required(id);
    // A stale tab or the other device must not keep autosaving into a deleted note.
    if (current.frontmatter.deleted_at) throw new Error("This note was deleted; it can no longer be edited");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, {}, { expectedHash, now, body });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * Edits a note's title and relationships without touching its body (PB-006). Only the fields in
   * `changes` move; `null` or an empty string clears a link. Links must point at a live object of
   * the right type, so a stale picker cannot write a dangling id. The file name is kept: paths and
   * titles may change without changing identity (ADR 0002). A change that alters nothing writes
   * nothing, so a retry does not add revisions.
   */
  async updateNoteMetadata(id: string, changes: Record<string, unknown>, expectedHash: string) {
    const current = this.ctx.required(id);
    if (!noteTypes.includes(current.frontmatter.type)) throw new Error("Only notes can be edited here");
    if (current.frontmatter.deleted_at) throw new Error("This note was deleted; it can no longer be edited");
    const selected: Record<string, unknown> = {};
    if ("title" in changes) {
      if (typeof changes.title !== "string" || !changes.title.trim()) throw new Error("Title is required");
      selected.title = changes.title.trim();
    }
    const live = (linkId: string, type: ObjectEnvelope["type"], label: string) => {
      const target = this.ctx.index.get(linkId);
      if (!target || target.frontmatter.type !== type || target.frontmatter.deleted_at || target.frontmatter.archived_at) throw new Error(`${label} not found`);
    };
    for (const [field, type, label] of [["primary_project_id", "project", "Project"], ["primary_client_id", "client", "Client"], ["primary_product_id", "product", "Product"]] as const) {
      if (!(field in changes)) continue;
      const value = changes[field];
      if (value === null || value === "") { selected[field] = undefined; continue; }
      if (typeof value !== "string") throw new Error(`${label} must be an id`);
      live(value, type, label);
      selected[field] = value;
    }
    if (current.frontmatter.type === "meeting-note" && "people_ids" in changes) {
      const value = changes.people_ids;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("People must be a list of ids");
      const people = [...new Set(value as string[])];
      people.forEach((personId) => live(personId, "person", "Person"));
      selected.people_ids = people;
    }
    const unchanged = Object.entries(selected).every(([key, value]) => JSON.stringify(current.frontmatter[key] ?? null) === JSON.stringify(value ?? null));
    if (unchanged) return current;
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, selected, { expectedHash, now });
    await this.ctx.writeAudit("note.metadata-updated", id, now, { fields: Object.keys(selected) });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * Deletes a meeting or knowledge note as a tombstone (PB-021): `deleted_at` is set and the file
   * stays on disk, so another device cannot resurrect it and it can be restored by hand. Physical
   * removal is a separate maintenance step. The meeting itself is kept; opening its event again
   * starts a fresh note. Idempotent: deleting an already-deleted note returns it unchanged.
   */
  async deleteNote(id: string, expectedHash: string) {
    const current = this.ctx.required(id);
    if (!noteTypes.includes(current.frontmatter.type)) throw new Error("Only notes can be deleted here");
    if (current.frontmatter.deleted_at) return current;
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, { deleted_at: now }, { expectedHash, now });
    await this.ctx.writeAudit("note.deleted", id, now, { type: current.frontmatter.type, meeting_id: current.frontmatter.meeting_id });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * Brings a deleted note back by clearing its tombstone (PB-025). Idempotent. A meeting shows one
   * note, so if the event already got a newer note after this one was deleted, restoring would leave
   * two; refuse and ask the user to delete the newer one first rather than guess which to keep.
   */
  async restoreNote(id: string, expectedHash: string) {
    const current = this.ctx.required(id);
    if (!noteTypes.includes(current.frontmatter.type)) throw new Error("Only notes can be restored here");
    if (!current.frontmatter.deleted_at) return current;
    const meetingId = current.frontmatter.meeting_id;
    if (meetingId && this.ctx.index.all().some((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meetingId && !object.frontmatter.deleted_at)) {
      throw new Error("This meeting already has a newer note. Delete that note first, then restore this one.");
    }
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, { deleted_at: undefined }, { expectedHash, now });
    await this.ctx.writeAudit("note.restored", id, now, { type: current.frontmatter.type, meeting_id: meetingId });
    await this.ctx.rebuildIndex();
    return updated;
  }
}
