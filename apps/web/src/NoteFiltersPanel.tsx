// Always-visible filter row for the Notes list (#105), the same controls as Decisions (#41).
import React from "react";
import { activeNoteFilterCount, noNoteFilters, noteTypeLabels, type NoteFilterState } from "./noteFilters.js";
import { SearchSelect } from "./SearchSelect.js";

type Option = { id: string; title: string };
type Props = {
  filters: NoteFilterState; onChange: (filters: NoteFilterState) => void; tab: "open" | "deleted";
  projects: Option[]; clients: Option[]; products: Option[]; people: Option[];
};

const typeOptions = Object.entries(noteTypeLabels).map(([id, title]) => ({ id, title }));

export function NoteFiltersPanel({ filters, onChange, tab, projects, clients, products, people }: Props) {
  const set = (patch: Partial<NoteFilterState>) => onChange({ ...filters, ...patch });
  const count = activeNoteFilterCount(filters);
  const dateLabel = tab === "open" ? "Last edited" : "Deleted";
  return <div className="note-filters" role="group" aria-label="Filter notes">
    <div className="note-filters-head"><small>FILTERS{count ? ` · ${count} active` : ""}</small><button disabled={!count} onClick={() => onChange(noNoteFilters)}>Clear filters</button></div>
    <div className="note-filter-grid">
      <SearchSelect multi label="Type" options={typeOptions} value={filters.types} onChange={(types) => set({ types })} placeholder="Any type" />
      <SearchSelect label="Project" options={projects} value={filters.projectId} onChange={(projectId) => set({ projectId })} placeholder="Any project" />
      <SearchSelect label="Client" options={clients} value={filters.clientId} onChange={(clientId) => set({ clientId })} placeholder="Any client" />
      <SearchSelect label="Product" options={products} value={filters.productId} onChange={(productId) => set({ productId })} placeholder="Any product" />
      <SearchSelect label="Person" options={people} value={filters.personId} onChange={(personId) => set({ personId })} placeholder="Anyone" />
      <label><small>{dateLabel} from</small><input type="date" value={filters.fromDay} max={filters.toDay || undefined} onChange={(event) => set({ fromDay: event.target.value })} /></label>
      <label><small>{dateLabel} to</small><input type="date" value={filters.toDay} min={filters.fromDay || undefined} onChange={(event) => set({ toDay: event.target.value })} /></label>
    </div>
  </div>;
}

/** Picker options for a list of project, client, product or person objects. */
export const entityOptions = (objects: Array<{ frontmatter: { id: string; title: string } }>): Option[] => objects.map((object) => ({ id: object.frontmatter.id, title: object.frontmatter.title }));
