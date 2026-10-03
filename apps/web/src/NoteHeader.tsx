// Header of the open note (PB-006): click the title to rename it, and pick project, client,
// product and people from searchable dropdowns right under it. Every change saves on its own, so
// there is no separate Save step; a failed save puts the previous value back.
import React, { useEffect, useRef, useState } from "react";
import { noteDetailsChanges, noteDetailsForm, type NoteDetailsForm } from "./noteDetailsForm.js";
import { SearchSelect } from "./SearchSelect.js";
import type { SearchOption } from "./searchOptions.js";

type HeaderNote = { frontmatter: Record<string, unknown> & { id: string; title: string; type: string }; contentHash: string };

export function NoteHeader({ note, kind, projects, clients, products, people, disabled, onSave, children }: {
  note: HeaderNote;
  kind: string;
  projects: SearchOption[];
  clients: SearchOption[];
  products: SearchOption[];
  people: SearchOption[];
  disabled: boolean;
  onSave: (changes: Record<string, unknown>) => Promise<boolean>;
  children?: React.ReactNode;
}) {
  const [form, setForm] = useState<NoteDetailsForm>(() => noteDetailsForm(note.frontmatter));
  const [editingTitle, setEditingTitle] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setForm(noteDetailsForm(note.frontmatter)); }, [note.frontmatter.id, note.contentHash]);
  useEffect(() => { if (editingTitle) titleInput.current?.select(); }, [editingTitle]);

  async function change(next: NoteDetailsForm) {
    setForm(next);
    const changes = noteDetailsChanges(note.frontmatter, next);
    if (!Object.keys(changes).length) return;
    if (!(await onSave(changes))) setForm(noteDetailsForm(note.frontmatter));
  }

  function commitTitle() {
    setEditingTitle(false);
    // A blank title is not allowed: fall back to the saved one rather than saving nothing visible.
    if (!form.title.trim()) { setForm({ ...form, title: note.frontmatter.title }); return; }
    void change({ ...form, title: form.title.trim() });
  }

  return (
    <div className="note-header">
      <div className="note-header-top">
        <div className="note-header-title">
          <span>{kind}</span>
          {editingTitle
            ? <input ref={titleInput} className="title-input" aria-label="Note title" value={form.title} disabled={disabled}
                onChange={(event) => setForm({ ...form, title: event.target.value })} onBlur={commitTitle}
                onKeyDown={(event) => { if (event.key === "Enter") commitTitle(); else if (event.key === "Escape") { setForm({ ...form, title: note.frontmatter.title }); setEditingTitle(false); } }} />
            : <h3><button type="button" className="title-button" disabled={disabled} title="Click to rename" onClick={() => setEditingTitle(true)}>{note.frontmatter.title}<i aria-hidden>✎</i></button></h3>}
        </div>
        {children}
      </div>
      <div className="note-header-links">
        <SearchSelect label="Project" options={projects} value={form.projectId} disabled={disabled} onChange={(projectId) => void change({ ...form, projectId })} />
        <SearchSelect label="Client" options={clients} value={form.clientId} disabled={disabled} onChange={(clientId) => void change({ ...form, clientId })} />
        <SearchSelect label="Product" options={products} value={form.productId} disabled={disabled} onChange={(productId) => void change({ ...form, productId })} />
        {note.frontmatter.type === "meeting-note" && <SearchSelect multi label="People" options={people} value={form.peopleIds} placeholder="Add people" disabled={disabled} onChange={(peopleIds) => void change({ ...form, peopleIds })} />}
      </div>
    </div>
  );
}
