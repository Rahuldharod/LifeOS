import { uuidV7, type ObjectEnvelope } from "@lifeos/domain";
import { isNoteType, noteTypes, standaloneNoteTitle } from "@lifeos/shared";
import { foldForSearch, markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { operationKinds, type Operation } from "./ports.js";
import { isLive, liveMeetingNote, objectIdPattern, OneAtATime, parseInstantRange, sameValue } from "./support.js";


/** What createStandaloneNote takes (PB-034). */
export interface NewStandaloneNote { id: string; body: string; title?: string; metadata?: Record<string, unknown>; timeZone?: string; now?: string }

/** Another object that points at a note, as the permanent-delete check lists it (PB-030). */
export interface ObjectReference { id: string; type: string; title: string }

/**
 * What stands in the way of deleting a note permanently (PB-030). `blockers` reference it in their front matter
 * (`*_id` / `*_ids`) and refuse the delete; `bodyLinks` only link to it in their text (`lifeos://object/<id>`),
 * which is a warning: those links will show as missing.
 */
export interface PurgeCheck { blockers: ObjectReference[]; bodyLinks: ObjectReference[] }

/** PB-030: the note is still referenced in other objects' front matter; `references` lists them. Mapped to HTTP 409. */
export class NoteReferencedError extends Error {
  override name = "NoteReferencedError";
  constructor(message: string, readonly references: ObjectReference[]) { super(message); }
}

interface PurgePayload { noteId: string; relativePath: string; title: string; contentHash: string }

/** True when a front-matter field named `*_id` or `*_ids` holds `id`. */
function referencesInFrontmatter(frontmatter: ObjectEnvelope, id: string) {
  return Object.entries(frontmatter).some(([field, value]) =>
    (field.endsWith("_id") && value === id) || (field.endsWith("_ids") && Array.isArray(value) && value.includes(id)));
}

/**
 * Notes list filters (#105). `from`/`to` are ISO instants, inclusive, on `updated_at` (open tab) or `deleted_at`
 * (deleted tab). Project, client, product and person match meeting notes only (person: the note's own `people_ids`).
 */
export type NoteFilters = { types?: string[]; projectId?: string; clientId?: string; productId?: string; personId?: string; from?: string; to?: string };

/** Meeting, knowledge and standalone notes: creating (standalone), listing, search, body and metadata edits, delete and restore. */
export class NotesModule {
  /** PB-030: one permanent delete per note at a time (double-click, two tabs; ADR 0013). */
  private readonly purges = new OneAtATime();
  /** PB-034: one create per note id at a time, so a double-submitted first edit finds the note the first one wrote. */
  private readonly creates = new OneAtATime();

  constructor(private readonly ctx: AppContext) {}

  /** One Note by id, live or deleted (#173); undefined when the id is not a Note. */
  note(id: string) {
    const object = this.ctx.index.get(id);
    return object && isNoteType(object.frontmatter.type) ? object : undefined;
  }

  notes() {
    return this.ctx.index.all()
      .filter((object) => isNoteType(object.frontmatter.type) && isLive(object))
      .sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at));
  }

  /** Tombstoned notes (PB-021), most recently deleted first. */
  deletedNotes() {
    return this.ctx.index.all()
      .filter((object) => isNoteType(object.frontmatter.type) && object.frontmatter.deleted_at && !object.frontmatter.archived_at)
      .sort((left, right) => Date.parse(String(right.frontmatter.deleted_at)) - Date.parse(String(left.frontmatter.deleted_at)));
  }

  /**
   * Keyword search over the in-memory index (PB-025): a note matches when every word of `query`
   * appears in its title or body, ignoring case and accents. It never touches the filesystem, so
   * cost depends on the notes already loaded, not on the folder. A blank query returns the whole tab.
   */
  searchNotes(query: string, state: "open" | "deleted" = "open", filters: NoteFilters = {}) {
    const types = filters.types ?? [];
    if (types.some((type) => !isNoteType(type))) throw new Error(`Note type must be one of ${noteTypes.join(", ")}`);
    const { from, to } = parseInstantRange(filters.from, filters.to);
    const dateField = state === "deleted" ? "deleted_at" : "updated_at";
    const needsContextFields = Boolean(filters.projectId || filters.clientId || filters.productId || filters.personId);
    const notes = (state === "deleted" ? this.deletedNotes() : this.notes()).filter(({ frontmatter }) => {
      const stamp = Date.parse(String(frontmatter[dateField]));
      return (!types.length || types.includes(frontmatter.type))
        && (!needsContextFields || frontmatter.type === "meeting-note" || frontmatter.type === "standalone-note")
        && (!filters.projectId || frontmatter.primary_project_id === filters.projectId)
        && (!filters.clientId || frontmatter.primary_client_id === filters.clientId)
        && (!filters.productId || frontmatter.primary_product_id === filters.productId)
        && (!filters.personId || (Array.isArray(frontmatter.people_ids) && frontmatter.people_ids.includes(filters.personId)))
        && stamp >= from && stamp <= to;
    });
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
    if (!isNoteType(current.frontmatter.type)) throw new Error("Only notes can be edited here");
    if (current.frontmatter.deleted_at) throw new Error("This note was deleted; it can no longer be edited");
    const selected = this.validatedChanges(current.frontmatter.type, changes);
    if (current.frontmatter.type === "meeting-note" && current.frontmatter.recurrence_series_id && typeof selected.title === "string" && selected.title !== current.frontmatter.title) {
      // A recurring Note follows Calendar renames only until the user deliberately names it.
      // This durable marker also protects the title from later syncs and retries.
      selected.title_manually_renamed = true;
    }
    const unchanged = Object.entries(selected).every(([key, value]) => sameValue(current.frontmatter[key], value));
    if (unchanged) return current;
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, selected, { expectedHash, now });
    await this.ctx.writeAudit("note.metadata-updated", id, now, { fields: Object.keys(selected) });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * Creates a Standalone Note (PB-034, ADR 0023): no meeting, no source, in `notes/`. The browser picks the id before
   * anything exists, so a retried first edit finds the note by id and returns it instead of writing a second file.
   * `metadata` holds the header choices made before the first edit (title, project, client, product, people,
   * sensitivity); they are checked like a metadata edit and written in the same single file write. `title` defaults to
   * `Note <date time>` in `timeZone` (UTC when not given), which also sets the time in the file name (ADR 0002).
   */
  async createStandaloneNote(input: NewStandaloneNote) {
    if (!objectIdPattern.test(input.id)) throw new Error("Note id must be a UUID");
    return this.creates.run(input.id, () => this.writeStandaloneNote(input));
  }

  private async writeStandaloneNote(input: NewStandaloneNote) {
    const existing = this.ctx.index.get(input.id);
    if (existing) {
      if (existing.frontmatter.type !== "standalone-note") throw new Error(`Object ${input.id} already exists and is not a standalone note`);
      return existing;
    }
    const now = input.now ?? new Date().toISOString();
    const timeZone = input.timeZone ?? "UTC";
    try { standaloneNoteTitle(now, timeZone); } catch { throw new Error("timeZone is not a valid time zone"); }
    const held = this.validatedChanges("standalone-note", { ...input.metadata, ...(input.title !== undefined ? { title: input.title } : {}) });
    const title = typeof held.title === "string" ? held.title : standaloneNoteTitle(now, timeZone);
    const created = await this.ctx.objects.write({
      relativePath: `notes/${markdownFileName(title, input.id, now, timeZone)}`,
      frontmatter: { ...this.ctx.envelope(input.id, "standalone-note", title, now, "app"), ...held, title },
      body: input.body
    });
    await this.ctx.rebuildIndex();
    return created;
  }

  /**
   * Checks a title and relationship change set (PB-006) and returns only the fields that move. Links must point at a
   * live object of the right type, so a stale picker cannot write a dangling id. Shared by edits and by creating
   * a Standalone Note with held header choices.
   */
  private validatedChanges(noteType: string, changes: Record<string, unknown>) {
    const selected: Record<string, unknown> = {};
    if ("title" in changes) {
      if (typeof changes.title !== "string" || !changes.title.trim()) throw new Error("Title is required");
      selected.title = changes.title.trim();
    }
    const live = (linkId: string, type: ObjectEnvelope["type"], label: string) => {
      const target = this.ctx.index.get(linkId);
      if (!target || target.frontmatter.type !== type || !isLive(target)) throw new Error(`${label} not found`);
    };
    for (const [field, type, label] of [["primary_project_id", "project", "Project"], ["primary_client_id", "client", "Client"], ["primary_product_id", "product", "Product"]] as const) {
      if (!(field in changes)) continue;
      const value = changes[field];
      if (value === null || value === "") { selected[field] = undefined; continue; }
      if (typeof value !== "string") throw new Error(`${label} must be an id`);
      live(value, type, label);
      selected[field] = value;
    }
    // #30: Area and sensitivity are validated centrally on write (AppContext.assertEnvelope); origin is never editable.
    if ("area" in changes) selected.area = changes.area === null || changes.area === "" ? undefined : changes.area;
    if ("sensitivity" in changes) selected.sensitivity = changes.sensitivity;
    if ((noteType === "meeting-note" || noteType === "standalone-note") && "people_ids" in changes) {
      const value = changes.people_ids;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("People must be a list of ids");
      const people = [...new Set(value as string[])];
      people.forEach((personId) => live(personId, "person", "Person"));
      selected.people_ids = people;
    }
    return selected;
  }

  /**
   * Deletes a meeting or knowledge note as a tombstone (PB-021): `deleted_at` is set and the file
   * stays on disk, so another device cannot resurrect it and it can be restored by hand. Physical
   * removal is a separate, explicit step (`purgeNote`, PB-030). The meeting itself is kept; opening its event again
   * starts a fresh note. Idempotent: deleting an already-deleted note returns it unchanged.
   */
  async deleteNote(id: string, expectedHash: string) {
    const current = this.ctx.required(id);
    if (!isNoteType(current.frontmatter.type)) throw new Error("Only notes can be deleted here");
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
    if (!isNoteType(current.frontmatter.type)) throw new Error("Only notes can be restored here");
    if (!current.frontmatter.deleted_at) return current;
    const meetingId = current.frontmatter.meeting_id;
    const seriesId = current.frontmatter.recurrence_series_id;
    if (typeof seriesId === "string" && this.ctx.index.all().some((note) => note.frontmatter.id !== id && note.frontmatter.type === "meeting-note" && note.frontmatter.recurrence_series_id === seriesId && isLive(note))) {
      throw new Error("This recurring series already has a newer live canonical Note. Delete that Note first, then restore this one.");
    }
    if (typeof meetingId === "string" && liveMeetingNote(meetingId, this.ctx.index.all())) {
      throw new Error("This meeting already has a newer note. Delete that note first, then restore this one.");
    }
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, { deleted_at: undefined }, { expectedHash, now });
    await this.ctx.writeAudit("note.restored", id, now, { type: current.frontmatter.type, meeting_id: meetingId });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /** PB-030: what the confirmation pop-up shows before a permanent delete. Only for deleted notes. */
  purgeCheck(id: string): PurgeCheck {
    this.tombstoned(id);
    return this.references(id);
  }

  /**
   * Deletes a deleted note for good (PB-030, ADR 0017): removes its Markdown file, then its kept versions, then
   * writes a `note.purged` audit with its id and title only. Refused unless the note is tombstoned, unchanged since
   * `expectedHash`, and no other object references it in its front matter. Journalled (ADR 0013): a crash between
   * the steps is finished at the next start, or by retrying the same delete.
   */
  purgeNote(id: string, expectedHash: string) {
    return this.purges.run(id, async () => {
      if (!expectedHash) throw new Error("expectedHash is required to delete a note permanently");
      if (!this.ctx.objects.remove) throw new Error("This object store cannot delete files");
      const pending = (await this.ctx.objects.incompleteOperations?.() ?? [])
        .find((operation) => operation.kind === operationKinds.purgeNote && operation.payload.noteId === id);
      if (pending) {
        // A retry after a crash: finish the delete the user already confirmed.
        await this.ctx.rebuildIndex();
        const finished = await this.finishPurge(pending);
        if (finished) return finished;
      }
      const current = this.tombstoned(id);
      if (current.contentHash !== expectedHash) throw new ObjectConflictError(`Note changed since it was opened: ${current.relativePath}`);
      const { blockers } = this.references(id);
      if (blockers.length) throw new NoteReferencedError(`Still referenced by ${blockers.length === 1 ? "1 object" : `${blockers.length} objects`}; remove those links first`, blockers);
      const payload: PurgePayload = { noteId: id, relativePath: current.relativePath, title: current.frontmatter.title, contentHash: expectedHash };
      const operation: Operation = { id: uuidV7(), kind: operationKinds.purgeNote, payload: { ...payload } };
      await this.ctx.objects.prepareOperation?.(operationKinds.purgeNote, operation.payload, operation.id);
      const finished = await this.finishPurge(operation);
      if (!finished) throw new ObjectConflictError(`Note changed since it was opened: ${current.relativePath}`);
      return finished;
    });
  }

  /** Startup recovery of an interrupted `purge-note` (ADR 0013). */
  async recoverPurge(operation: Operation) {
    await this.ctx.rebuildIndex();
    await this.purges.run(String(operation.payload.noteId), () => this.finishPurge(operation));
  }

  /**
   * Runs the remaining steps of a journalled permanent delete; each is safe to repeat. While the file is still
   * there it is checked again (still deleted, unchanged, unreferenced): if anything moved on, nothing is removed
   * and the operation is closed (rolled back), returning undefined.
   */
  private async finishPurge(operation: Operation) {
    const { noteId, title, contentHash } = operation.payload as unknown as PurgePayload;
    const current = this.ctx.index.get(noteId);
    if (current) {
      const unchanged = current.contentHash === contentHash && !!current.frontmatter.deleted_at && !this.references(noteId).blockers.length;
      try {
        if (!unchanged) throw new ObjectConflictError(`Note changed since it was opened: ${current.relativePath}`);
        await this.ctx.objects.remove!(current.relativePath, contentHash);
      } catch (error) {
        // Nothing was removed: close the operation so recovery never deletes without the user's guard.
        await this.ctx.objects.completeOperation?.(operation.id);
        if (error instanceof Error && error.name === "ObjectConflictError") return undefined;
        throw error;
      }
    }
    await this.ctx.objects.removeVersions?.(noteId);
    const now = new Date().toISOString();
    await this.ctx.writeAuditOnce("note.purged", noteId, now, { operation_id: operation.id, title }, { matchOn: ["operation_id"] });
    await this.ctx.objects.completeOperation?.(operation.id);
    await this.ctx.rebuildIndex();
    return { id: noteId, title };
  }

  private tombstoned(id: string) {
    const current = this.ctx.required(id);
    if (!isNoteType(current.frontmatter.type)) throw new Error("Only notes can be deleted permanently");
    if (!current.frontmatter.deleted_at) throw new Error("Only deleted notes can be deleted permanently; delete the note first");
    return current;
  }

  private references(id: string): PurgeCheck {
    const link = `lifeos://object/${id}`;
    const blockers: ObjectReference[] = [];
    const bodyLinks: ObjectReference[] = [];
    for (const object of this.ctx.index.all()) {
      const { frontmatter } = object;
      // Audit events name the note in `object_id` by design; they are history, not links.
      if (frontmatter.id === id || frontmatter.type === "audit-event") continue;
      const reference = { id: frontmatter.id, type: frontmatter.type, title: frontmatter.title };
      if (referencesInFrontmatter(frontmatter, id)) blockers.push(reference);
      else if (object.body.includes(link)) bodyLinks.push(reference);
    }
    return { blockers, bodyLinks };
  }
}
