import React, { type ReactNode, useEffect, useMemo, useState } from "react";
import type { CalendarEvent, LifeObject, OccurrenceWorkspaceItem } from "@lifeos/contracts";
import { meetingSummary } from "./meetingSummary.js";
import "./RecurringOccurrenceWorkspace.css";

type SectionRange = { sectionId: string; notesStart: number; notesEnd: number };

function materialsBlock(markdown: string, sectionId: string) {
  const start = `<!-- lifeos:materials:start ${sectionId} -->`;
  const end = `<!-- lifeos:materials:end ${sectionId} -->`;
  const from = markdown.indexOf(start);
  const to = from < 0 ? -1 : markdown.indexOf(end, from + start.length);
  return from >= 0 && to >= 0 ? markdown.slice(from, to + end.length) : "";
}

function ranges(markdown: string, occurrences: OccurrenceWorkspaceItem[]): SectionRange[] {
  return occurrences.flatMap((occurrence, index) => {
    const anchor = `<a id="${occurrence.sectionId}"></a>`;
    const anchorAt = markdown.indexOf(anchor);
    if (anchorAt < 0) return [];
    const notesStart = markdown.slice(anchorAt + anchor.length).match(/^\s*/)?.[0].length ?? 0;
    const next = occurrences[index + 1];
    const nextAnchorAt = next ? markdown.indexOf(`<a id="${next.sectionId}"></a>`, anchorAt + anchor.length) : -1;
    const nextHeadingAt = nextAnchorAt < 0 ? markdown.length : Math.max(0, markdown.lastIndexOf("\n## ", nextAnchorAt) + 1);
    return [{ sectionId: occurrence.sectionId, notesStart: anchorAt + anchor.length + notesStart, notesEnd: nextHeadingAt }];
  });
}

export function occurrenceNotes(markdown: string, occurrences: OccurrenceWorkspaceItem[], sectionId: string) {
  const range = ranges(markdown, occurrences).find((candidate) => candidate.sectionId === sectionId);
  if (!range) return "";
  const section = markdown.slice(range.notesStart, range.notesEnd);
  const managed = materialsBlock(section, sectionId);
  return (managed ? section.replace(managed, "") : section).trimEnd();
}

export function replaceOccurrenceNotes(markdown: string, occurrences: OccurrenceWorkspaceItem[], sectionId: string, notes: string) {
  const range = ranges(markdown, occurrences).find((candidate) => candidate.sectionId === sectionId);
  if (!range) return markdown;
  const before = markdown.slice(0, range.notesStart);
  const after = markdown.slice(range.notesEnd);
  const managed = materialsBlock(markdown.slice(range.notesStart, range.notesEnd), sectionId);
  const editable = notes.replace(/^\s+|\s+$/g, "");
  const section = [editable, managed].filter(Boolean).join("\n\n");
  return `${before}${section}${after ? "\n\n" : ""}${after}`;
}

function day(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function defaultOccurrenceSection(occurrences: OccurrenceWorkspaceItem[], now: Date, timeZone: string) {
  const today = day(now.toISOString(), timeZone);
  const chronological = [...occurrences].sort((left, right) => Date.parse(String(left.meeting.frontmatter.starts_at)) - Date.parse(String(right.meeting.frontmatter.starts_at)));
  return chronological.find((item) => day(String(item.meeting.frontmatter.starts_at), timeZone) === today)?.sectionId
    ?? chronological.find((item) => Date.parse(String(item.meeting.frontmatter.starts_at)) > now.getTime())?.sectionId
    ?? chronological.at(-1)?.sectionId;
}

function sourceLink(source: LifeObject) {
  const url = source.frontmatter.url;
  return typeof url === "string" ? url : undefined;
}

function eventDifferences(item: OccurrenceWorkspaceItem, current?: CalendarEvent) {
  if (!current) return [];
  const meeting = item.meeting.frontmatter;
  const changed: string[] = [];
  if (current.title !== meeting.title) changed.push(`Title: ${current.title}`);
  if (current.startsAt !== meeting.starts_at || current.endsAt !== meeting.ends_at) changed.push(`Time: ${new Date(current.startsAt).toLocaleString()}–${new Date(current.endsAt).toLocaleTimeString()}`);
  if ((current.location ?? "") !== (meeting.location ?? "")) changed.push(`Location: ${current.location || "removed"}`);
  if ((current.joinUrl ?? "") !== (meeting.join_url ?? "")) changed.push(`Joining link: ${current.joinUrl || "removed"}`);
  const savedAttendees = (Array.isArray(meeting.attendee_snapshot) ? meeting.attendee_snapshot.filter((attendee): attendee is string => typeof attendee === "string") : item.context.people.map((person) => person.frontmatter.title)).sort();
  const currentAttendees = [...current.attendees].sort();
  if (JSON.stringify(currentAttendees) !== JSON.stringify(savedAttendees)) changed.push(`Attendees: ${currentAttendees.join(", ") || "none"}`);
  if ((current.status ?? "confirmed") !== (meeting.status === "cancelled" ? "cancelled" : "confirmed")) changed.push(`Status: ${current.status ?? "confirmed"}`);
  return changed;
}

export function RecurringOccurrenceWorkspace({ note, occurrences, selectedSectionId, timeZone, mode, currentEvent, seriesNotes = [], readOnly, linkDisabled = false, onBodyChange, onLinkPrevious, renderProposal, onSelectSection }: {
  note: LifeObject;
  occurrences: OccurrenceWorkspaceItem[];
  selectedSectionId?: string;
  timeZone: string;
  mode: "calendar" | "notes";
  currentEvent?: CalendarEvent;
  seriesNotes?: LifeObject[];
  readOnly: boolean;
  linkDisabled?: boolean;
  onBodyChange: (body: string) => void;
  onLinkPrevious?: (noteId: string) => void;
  renderProposal: (review: LifeObject) => ReactNode;
  onSelectSection?: (sectionId: string) => void;
}) {
  const ordered = useMemo(() => [...occurrences].sort((left, right) => Date.parse(String(right.meeting.frontmatter.starts_at)) - Date.parse(String(left.meeting.frontmatter.starts_at))), [occurrences]);
  const fallback = defaultOccurrenceSection(ordered, new Date(), timeZone);
  const storageKey = `lifeos.occurrence-section.${note.frontmatter.id}`;
  const remembered = typeof localStorage === "undefined" ? undefined : localStorage.getItem(storageKey) ?? undefined;
  const [selected, setSelected] = useState(selectedSectionId ?? remembered ?? fallback);
  const [previousNoteId, setPreviousNoteId] = useState("");
  const previous = seriesNotes.find((candidate) => candidate.frontmatter.id === note.frontmatter.previous_series_note_id);
  const linkable = seriesNotes.filter((candidate) => candidate.frontmatter.id !== note.frontmatter.id && typeof candidate.frontmatter.recurrence_series_id === "string");
  useEffect(() => { if (selectedSectionId) setSelected(selectedSectionId); else if (!selected || !ordered.some((item) => item.sectionId === selected)) setSelected(fallback); }, [selectedSectionId, fallback, ordered, selected]);

  return <section className="recurring-occurrence-workspace" aria-label="Recurring meeting occurrences">
    {previous ? <p className="series-continuity">Previous recurring Note: <b>{previous.frontmatter.title}</b></p> : onLinkPrevious && linkable.length > 0 ? <div className="series-continuity">
      <label><span>Previous recurring Note</span><select aria-label="Previous recurring Note" value={previousNoteId} disabled={readOnly || linkDisabled} onChange={(event) => setPreviousNoteId(event.target.value)}><option value="">Choose a Note…</option>{linkable.map((candidate) => <option value={candidate.frontmatter.id} key={candidate.frontmatter.id}>{candidate.frontmatter.title}</option>)}</select></label>
      <button type="button" disabled={readOnly || linkDisabled || !previousNoteId} onClick={() => onLinkPrevious(previousNoteId)}>Link previous Note</button>
    </div> : null}
    {ordered.map((item) => {
      const active = item.sectionId === selected;
      const meeting = item.meeting.frontmatter;
      const pending = item.reviews.filter((review) => review.frontmatter.status === "pending");
      const acceptedSummary = meetingSummary(item.meeting.body);
      const current = currentEvent?.originalOccurrenceStartsAt === item.originalStartsAt ? currentEvent : undefined;
      const differences = eventDifferences(item, current);
      const select = () => { setSelected(item.sectionId); localStorage.setItem(storageKey, item.sectionId); };
      return <details key={item.sectionId} className={active ? "occurrence-section selected" : "occurrence-section"} open={active || undefined} onToggle={(event) => { if (event.currentTarget.open) { select(); onSelectSection?.(item.sectionId); } }}>
        <summary><span>{new Date(String(meeting.starts_at)).toLocaleDateString([], { timeZone, dateStyle: "full" })}</span><b>{new Date(String(meeting.starts_at)).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" })}–{new Date(String(meeting.ends_at)).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" })}</b>{(meeting.status === "cancelled" || current?.status === "cancelled") && <em>Cancelled</em>}</summary>
        <div className="occurrence-snapshot" aria-label="Saved event snapshot">
          <span>SAVED EVENT DETAILS</span>
          <p><b>{meeting.title}</b></p>
          <p>{Array.isArray(meeting.attendee_snapshot) ? meeting.attendee_snapshot.filter((attendee): attendee is string => typeof attendee === "string").join(", ") || "No attendees" : item.context.people.length ? item.context.people.map((person) => person.frontmatter.title).join(", ") : "No attendees"}</p>
          {Boolean(meeting.location || meeting.join_url) && <p>{String(meeting.location ?? "")}{meeting.location && meeting.join_url ? " · " : ""}{Boolean(meeting.join_url) && <a href={String(meeting.join_url)}>Join meeting</a>}</p>}
        </div>
        {differences.length > 0 && <aside className="occurrence-calendar-changes" aria-label="Current Calendar changes"><b>Changed in Calendar</b><ul>{differences.map((change) => <li key={change}>{change}</li>)}</ul></aside>}
        <label className="occurrence-notes"><span>Your notes</span><textarea aria-label={`Notes for ${item.sectionId}`} disabled={readOnly} value={occurrenceNotes(note.body, ordered, item.sectionId)} onChange={(event) => onBodyChange(replaceOccurrenceNotes(note.body, ordered, item.sectionId, event.target.value))} /></label>
        <section className="occurrence-materials"><h4>Materials</h4>{item.sources.length ? <ul>{item.sources.map((source) => <li key={source.frontmatter.id}>{sourceLink(source) ? <a href={sourceLink(source)}>{source.frontmatter.title}</a> : source.frontmatter.title}{Boolean(source.frontmatter.retrieved_at) && <small> Retrieved {new Date(String(source.frontmatter.retrieved_at)).toLocaleString()}</small>}</li>)}</ul> : <p>No linked materials.</p>}</section>
        {acceptedSummary && <section className="occurrence-summary"><h4>Accepted summary</h4><p>{acceptedSummary}</p></section>}
        {(mode === "notes" || active) && <section className="occurrence-proposals"><h4>Pending proposals</h4>{pending.length ? pending.map((review) => <React.Fragment key={review.frontmatter.id}>{renderProposal(review)}</React.Fragment>) : <p>No pending proposals.</p>}</section>}
      </details>;
    })}
  </section>;
}
