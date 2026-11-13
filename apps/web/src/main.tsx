import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useLocation } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./design-tokens.css";
import "./styles.css";
import { isConflictedDraft } from "./noteDraft.js";
import { NoteConflictPanel } from "./NoteConflictPanel.js";
import { api, ApiError, useServerConnection } from "./api.js";
import { clearCachedDraft, readCachedDraft, readCachedPendingDraft } from "./draftStorage.js";
import { useCalendar } from "./useCalendar.js";
import { useWorkspaceData } from "./useWorkspaceData.js";
import { useNoteDraftController, type NoteDraftController } from "./useNoteDraftController.js";
import { EditorFrame } from "./EditorFrame.js";
import { NoteHeader, PENDING_NOTE_HASH } from "./NoteHeader.js";
import { isRestricted } from "./envelope.js";
import { entityOptions, foldText } from "./searchOptions.js";
import { hasRawAnchorLines } from "./editorMarkdown.js";
import { MarkdownEditor, ModeSwitch, type EditorOwner } from "./MarkdownEditor.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { withOpenedArchived, type LinkedObject } from "./lifeosLinks.js";
import { useLifeosLinks } from "./useLifeosLinks.js";
import { addCalendarDays, dateInTimeZone, dayRange } from "./zonedTime.js";
import { DecisionsPage } from "./DecisionsPage.js";
import { activeNoteFilterCount, emptyNotesMessage, noNoteFilters, noteListQuery } from "./noteFilters.js";
import { externalChoiceValue, labelMap, personLabel, personOption, type ExternalChoice } from "./personLabels.js";
import { applyToEach, describeBulkResult, type BulkResult, type PeopleBulkAction } from "./peopleBulkRules.js";
import { PersonName } from "./PersonName.js";
import { MeetingEnrichment } from "./MeetingEnrichment.js";
import { OpenPointsPage } from "./OpenPointsPage.js";
import { HistoryLink } from "./HistoryPanel.js";
import { CopyLink } from "./CopyLink.js";
import { awaitingAdoptionLabel } from "./todayPanels.js";
import { LinkResolutionCard, type LinkCardActions } from "./LinkResolutionCard.js";
import { acceptLink, acceptToast, createLinkTarget } from "./linkResolution.js";
import { reviewInFlight } from "./reviewInFlight.js";
import { displayTimeZone as storedDisplayTimeZone, formatDate } from "./dateFormat.js";
import { contextLinkFields } from "@lifeos/shared";
import { PageHeader, Summary } from "./pageParts.js";
import { TodayPage } from "./TodayPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { createSettingsEditorGuard, type SettingsSection } from "./SettingsWorkspace.js";
import { ReferenceDataSettings } from "./ReferenceDataSettings.js";
import type { AddEmailOutcome } from "./PersonEmails.js";
import { parseReferenceSettingsId, referenceCardIdFromRoute, referenceRouteInSettings, referenceSettingsCardId, referenceSettingsId, type ReferenceEntityType } from "./referenceSettingsRoutes.js";
import { SelfEmailWarning } from "./SelfEmailWarning.js";
import { MeetingNoteActions } from "./MeetingNoteActions.js";
import { takeoverCaution } from "./LeaseBanner.js";
import { AppStatusBanners } from "./ConnectionDeviceSettings.js";
import { useActivityHeartbeat } from "./activityHeartbeat.js";
import { AboutLifeOS } from "./AboutLifeOS.js";
import { BackupWarning } from "./BackupWarning.js";
import { SensitivityToggle } from "./SensitivityToggle.js";
import { PermanentDeleteButton } from "./PermanentDelete.js";
import { CalendarWorkspace } from "./CalendarWorkspace.js";
import { parseRoute, routePath, routeTarget, type Route, type View } from "./routes.js";
import { useGuardedNavigation } from "./useGuardedNavigation.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ApplicationShell } from "./ApplicationShell.js";
import { GlobalSearchOverlay } from "./GlobalSearchOverlay.js";
import { calendarSearchRange, recordRecentSearchId } from "./globalSearch.js";
import { CapturePanel, type CaptureRequest } from "./CapturePanel.js";
import { OverlayDialog } from "./OverlayDialog.js";
import { FeedbackDialog, useAppFeedback } from "./FeedbackDialog.js";
import { TaskWorkspace, createStructuredEditorGuard } from "./TaskWorkspace.js";
import { SeriesView } from "./SeriesView.js";
import { noteSeriesRoute } from "./noteSeriesLink.js";
import { SaveState } from "./SaveState.js";
import { useSeriesEditorGuard } from "./seriesEditorGuard.js";
import { meetingSummary } from "./meetingSummary.js";
import { noteDeletePrompt } from "./noteDeletePrompt.js";
import { NotesWorkspace } from "./NotesWorkspace.js";
import { useNewStandaloneNote } from "./useNewStandaloneNote.js";
import { InboxWorkspace } from "./InboxWorkspace.js";
import { KnowledgeWorkspace } from "./KnowledgeWorkspace.js";
import { buildTrail } from "./trail.js";
import { firstEditPeopleIds, headerPeopleIds } from "./firstEditPeople.js";
import { DuplicateCleanupCard } from "./DuplicateCleanupCard.js";
import type { AppliedPatch, BackupVerification, CalendarDay, CalendarEvent, FocusChange, GoogleConnection, LifeObject, PersonLabel, PersonMergeChoice, ReviewEdits, ReviewEvidence, Workspace } from "@lifeos/contracts";

/** PB-027: `/` (and an unknown path) resumes the last page; the only place the page is kept outside the URL. */
const lastPathKey = "lifeos.lastPath";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

type ReviewChoices = Record<"people" | "projects" | "clients" | "products", Array<{ id: string; title: string }>>;
/** Which proposal fields the user may edit before accepting, per target type (#34). */
const reviewEditable: Record<string, string[]> = {
  task: ["owner_person_id", "due_on", "priority", ...contextLinkFields],
  decision: [...contextLinkFields],
  "open-point": ["owner_person_id", ...contextLinkFields]
};

/**
 * The text of the Summary section of a meeting body (written by accepting a summary Review Item, #45): between
 * the #66 markers, so the summary's own headings are shown; an older unmarked one ends at the next heading.
 */
function ReviewCard({ review, busy, onAccept, onReject, onSave, evidence, choices, labels, linkActions }: {
  review: LifeObject;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSave: (changes: ReviewEdits) => void;
  /** Evidence per proposed field; a source that cannot be found is shown as unresolved. */
  evidence?: Record<string, ReviewEvidence[]>;
  choices?: ReviewChoices;
  /** #57: display labels and actions for the link-resolution card. */
  labels: Map<string, PersonLabel>;
  linkActions: LinkCardActions;
}) {
  const proposed = (review.frontmatter.proposed_fields ?? {}) as Record<string, unknown>;
  const target = String(review.frontmatter.target_object_type ?? "task");
  const current = (key: string) => String((key.startsWith("primary_") ? review.frontmatter[key] : proposed[key]) ?? "");
  const editable = review.frontmatter.review_type === "create" ? reviewEditable[target] ?? [] : [];
  const unresolvedNames = Array.isArray(review.frontmatter.unresolved_references) ? review.frontmatter.unresolved_references as Array<{ field: string; reference: string; problem: string }> : [];
  const [title, setTitle] = useState(review.frontmatter.title);
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((key) => [key, current(key)])));
  const pending = review.frontmatter.status === "pending";
  if (review.frontmatter.review_type === "link-resolution") return <LinkResolutionCard review={review} labels={labels} busy={busy} actions={linkActions} />;
  // #37: a change to an existing object (from a Patch Draft) shows current vs proposed per field; it cannot be renamed.
  if (review.frontmatter.review_type === "update") {
    const proposal = review.frontmatter.proposed_fields as { changes?: Array<{ field: string; current: unknown; proposed: unknown }>; append_note?: string; reasons?: string[] };
    const show = (value: unknown) => value === null || value === undefined ? "(none)" : typeof value === "string" ? value : JSON.stringify(value);
    return <div className="review-card">
      <b>{review.frontmatter.title}</b>
      <small>{(proposal.reasons ?? []).join(" · ")} · {review.frontmatter.status}</small>
      <table className="review-changes"><thead><tr><th>Field</th><th>Current</th><th>Proposed</th></tr></thead><tbody>
        {(proposal.changes ?? []).map((change) => <tr key={change.field}><td>{change.field}</td><td>{show(change.current)}</td><td>{show(change.proposed)}</td></tr>)}
        {proposal.append_note && <tr><td>note</td><td>(none)</td><td>{proposal.append_note}</td></tr>}
      </tbody></table>
      {pending && <div className="review-actions">
        <button className="primary" disabled={busy} onClick={onAccept}>Apply change</button>
        <button className="danger" disabled={busy} onClick={onReject}>Reject</button>
      </div>}
    </div>;
  }
  // #40: a merge suggestion has nothing to edit; it shows why it was proposed and what accepting does.
  if (review.frontmatter.review_type === "person-merge") return <div className="review-card">
    <b>{review.frontmatter.title}</b>
    <small>{String(review.frontmatter.confidence_label)} confidence · {review.frontmatter.status}{typeof review.frontmatter.merge_problem === "string" ? ` · ${review.frontmatter.merge_problem}` : ""}</small>
    <p>{review.body.replace(/^# .*\n+/, "").trim()}</p>
    {pending && <div className="review-actions">
      <button className="primary" disabled={busy} onClick={onAccept}>Merge</button>
      <button className="danger" disabled={busy} onClick={onReject}>Keep separate</button>
    </div>}
  </div>;
  // #45: an AI meeting summary; accepting writes the Summary section of the meeting, never the user's note.
  if (review.frontmatter.review_type === "summary") return <div className="review-card">
    <b>{review.frontmatter.title}</b>
    <small>meeting summary · {String(review.frontmatter.confidence_label)} confidence · {review.frontmatter.status}</small>
    <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{String(proposed.summary ?? "")}</ReactMarkdown></div>
    {pending && <div className="review-actions">
      <button className="primary" disabled={busy} onClick={onAccept}>Accept summary</button>
      <button className="danger" disabled={busy} onClick={onReject}>Reject</button>
    </div>}
  </div>;
  const changes: ReviewEdits = Object.fromEntries([
    ...(title.trim() !== review.frontmatter.title ? [["title", title]] : []),
    ...editable.filter((key) => fields[key] !== current(key)).map((key) => [key, fields[key] || null])
  ]);
  const select = (key: string, label: string, options: Array<{ id: string; title: string }>) => <label key={key}>{label}
    <select value={fields[key] ?? ""} disabled={!pending || busy} onChange={(event) => setFields({ ...fields, [key]: event.target.value })}>
      <option value="">{key === "owner_person_id" ? "Me" : "None"}</option>
      {options.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
    </select></label>;
  const evidenceEntries = Object.values(evidence ?? {}).flat();
  return <div className="review-card">
    {pending ? <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Proposed title" /> : <b>{review.frontmatter.title}</b>}
    <small>{target} · {String(review.frontmatter.confidence_label)} confidence · {review.frontmatter.status}{review.frontmatter.origin === "agent-extracted" ? " · agent-extracted" : ""}{review.frontmatter.missed_in_notes === true ? <> · <strong>Not in your notes</strong></> : null}</small>
    {pending && editable.length > 0 && <div className="review-fields">
      {editable.includes("owner_person_id") && select("owner_person_id", "Owner", choices?.people ?? [])}
      {editable.includes("due_on") && <label>Due<input type="date" value={fields.due_on ?? ""} disabled={busy} onChange={(event) => setFields({ ...fields, due_on: event.target.value })} /></label>}
      {editable.includes("priority") && select("priority", "Priority", ["High", "Medium", "Low"].map((value) => ({ id: value, title: value })))}
      {select("primary_project_id", "Project", choices?.projects ?? [])}
      {select("primary_client_id", "Client", choices?.clients ?? [])}
      {select("primary_product_id", "Product", choices?.products ?? [])}
    </div>}
    {unresolvedNames.length > 0 && <p className="review-evidence unresolved">Not linked yet: {unresolvedNames.map((entry) => `${entry.field} "${entry.reference}" (${entry.problem})`).join(", ")}</p>}
    {evidenceEntries.length > 0 && <ul className="review-evidence">
      {evidenceEntries.map((entry, index) => <li key={index}><em>{entry.field}</em>{" "}
        {entry.resolved ? <span>{entry.source_title}</span> : <span className="unresolved">Unresolved source: {entry.source_ref ?? entry.source_id}</span>}
        {entry.locator ? ` · ${entry.locator}` : ""}{entry.quote ? <q>{entry.quote}</q> : null}</li>)}
    </ul>}
    {pending && <div className="review-actions">
      <button disabled={busy || !Object.keys(changes).length} onClick={() => onSave(changes)}>Save edit</button>
      <button className="primary" disabled={busy || Object.keys(changes).length > 0} title={Object.keys(changes).length ? "Save your edits first" : undefined} onClick={onAccept}>Accept {target}</button>
      <button className="danger" disabled={busy} onClick={onReject}>Reject</button>
    </div>}
  </div>;
}

function App() {
  // PB-027: the URL says which tab and which item are open.
  const location = useLocation();
  const parsedRoute = parseRoute(location.pathname);
  const route = parsedRoute ? referenceRouteInSettings(parsedRoute) : undefined;
  const view: View = route?.view ?? "Today";
  const [workspace, setWorkspace] = useState<Workspace>();
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  // PB-025: Open/Deleted tabs and keyword search over the notes list.
  const noteTab: "open" | "deleted" = route?.view === "Notes" && route.noteTab === "deleted" ? "deleted" : "open";
  const [noteQuery, setNoteQuery] = useState("");
  // #105: filters survive Open/Deleted and Back from a note; they reset only when leaving the Notes view.
  const [noteFilters, setNoteFilters] = useState(noNoteFilters);
  const noteFilterCount = activeNoteFilterCount(noteFilters);
  useEffect(() => { if (route?.view !== "Notes") setNoteFilters(noNoteFilters); }, [route?.view]);
  const [noteResults, setNoteResults] = useState<LifeObject[]>();
  const [selectedDeletedId, setSelectedDeletedId] = useState<string>();
  const [highlightId, setHighlightId] = useState<string>();
  const [capture, setCapture] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCalendar, setSearchCalendar] = useState<CalendarDay & { unavailable?: true }>({ events: [] });
  const [captureOpen, setCaptureOpen] = useState(false);
  const [lastVerification, setLastVerification] = useState<BackupVerification>();
  const [googleConnection, setGoogleConnection] = useState<GoogleConnection>();
  const [displayTimeZone, setDisplayTimeZone] = useState(storedDisplayTimeZone);
  const { today, todayPanels, tasks, projects, reviews, health, backups, knowledge, clients, products, people, notAPersonPeople, objectLinks, notes, deletedNotes, inboxDrafts, appliedPatches, personLabels, enrichment, connections, refresh, refreshTodayPanels, refreshConnections, refreshNotes, refreshNoteLists, refreshObjectLinks, updateNotes, updateToday, updateHealth } = useWorkspaceData({ displayTimeZone });
  const [selectedDate, setSelectedDate] = useState(() => (route?.view === "Calendar" && route.date) || dateInTimeZone(new Date(), storedDisplayTimeZone()));
  // PB-027: open items in the URL are resolved only once the lists they live in have loaded.
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const refreshGoogleConnection = () => { void api("GET /api/v1/connections/google").then(setGoogleConnection).catch(() => undefined); };
  const [message, setMessage] = useState("Loading local workspace…");
  const calendar = useCalendar({ selectedDate, displayTimeZone, onFailure: setMessage, onGoogleStatusStale: refreshGoogleConnection });
  const [editorMode, setEditorMode] = useState<"visual" | "write" | "preview">("visual");
  const [busy, setBusy] = useState(false);
  const taskEditorGuard = useRef(createStructuredEditorGuard()).current;
  const decisionEditorGuard = useRef(createStructuredEditorGuard()).current;
  const openPointEditorGuard = useRef(createStructuredEditorGuard()).current;
  const settingsEditorGuard = useRef(createSettingsEditorGuard()).current;
  const seriesEditors = useSeriesEditorGuard();
  const selectedNote = notes.find((note) => note.frontmatter.id === selectedNoteId);
  const seriesRoute = selectedNote ? noteSeriesRoute(selectedNote, objectLinks, displayTimeZone) : undefined;
  // Which notes show a "Conflict" badge in the list — any note with a cached browser draft whose
  // base hash no longer matches the file on disk, whether or not it's the one currently open.
  const conflictedNoteIds = new Set(notes.filter((note) => isConflictedDraft(readCachedDraft(note), note)).map((note) => note.frontmatter.id));
  const readOnly = health?.session.writeAllowed === false;
  const releasedAfterIdle = readOnly && health?.session.releasedAfterIdle === true;
  // ADR 0015: real input in this tab keeps (or, when free, claims) the write lease; the answer refreshes read-only state.
  useActivityHeartbeat(async () => {
    const session = await api("POST /api/v1/session/activity");
    updateHealth((current) => current ? { ...current, session } : current);
  });

  // Shared by notesController's `fetchLatest` option and the tab-refocus listener below: a "soft"
  // refetch that only updates the notes list state, letting useNoteDraftController's own reconcile
  // effect (watching note?.contentHash) decide whether to resync silently or flag a conflict.
  // Deliberately does NOT call notesController.open() — that would hard-reset the draft and skip
  // conflict detection entirely.
  const fetchLatestNote = useCallback(async () => {
    const refreshed = await refreshNotes();
    return refreshed.find((candidate) => candidate.frontmatter.id === selectedNoteId);
  }, [selectedNoteId]);

  // Same "soft" refetch shape as fetchLatestNote, for the Calendar meeting workspace. No-ops when
  // no workspace is open. Deliberately does NOT call meetingController.open() for the same reason.
  const fetchLatestWorkspace = useCallback(async () => {
    if (!workspace || workspace.persisted === false) return undefined;
    const next = await api("GET /api/v1/meetings/:id/workspace", { params: { id: workspace.meeting.frontmatter.id } });
    setWorkspace(next);
    return next.note;
  }, [workspace]);

  // One shared draft/conflict controller per editor (Notes, Calendar meeting workspace) — see
  // useNoteDraftController.ts. Each owns its own draft, base hash and conflict state, so switching
  // views can never leak one editor's conflict flag into the other.
  // The calendar event whose note does not exist on disk yet, if the open workspace is a preview.
  const createdWorkspace = useRef<Workspace | undefined>(undefined);
  // Title and relationship changes made before a calendar note exists. They wait here and are applied
  // right after the first edit creates the note (PB-006), so opening an event still writes nothing.
  const pendingDetails = useRef<Record<string, unknown>>({});
  const previewTarget = useRef<{ externalId: string; calendarId?: string; date: string; timeZone: string } | undefined>(undefined);
  // Bumped only when the user opens an event, so the visual editor keeps its instance (and cursor)
  // when a first edit turns the preview into a persisted workspace.
  const [editorSession, setEditorSession] = useState(0);
  const server = useServerConnection();
  // PB-034: the first edit of an unsaved Standalone Note creates it; the Notes list then shows it like any other note.
  // The note a first edit just created, until the URL names it (the open note changes a render before the URL does).
  const createdNoteId = useRef<string | undefined>(undefined);
  const newNote = useNewStandaloneNote({
    timeZone: displayTimeZone,
    onCreated: (created) => {
      updateNotes((current) => [created as LifeObject, ...current.filter((note) => note.frontmatter.id !== created.frontmatter.id)]);
      createdNoteId.current = created.frontmatter.id;
      setSelectedNoteId(created.frontmatter.id);
      followRoute({ view: "Notes", noteTab: "open", id: created.frontmatter.id }, { replace: true });
      void refresh();
    }
  });
  const notesController = useNoteDraftController({
    note: selectedNote,
    readOnly,
    busy,
    onMessage: setMessage,
    onSaved: (updated) => updateNotes((current) => current.map((note) => note.frontmatter.id === updated.frontmatter.id ? updated as LifeObject : note).sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at))),
    fetchLatest: fetchLatestNote,
    createNote: newNote.createNote
  });
  const meetingController = useNoteDraftController({
    note: workspace?.note,
    readOnly,
    busy,
    onMessage: setMessage,
    onSaved: (updated) => setWorkspace((current) => current?.note?.frontmatter.id === updated.frontmatter.id ? { ...current, note: updated as LifeObject } : current),
    fetchLatest: fetchLatestWorkspace,
    createNote: async (body) => {
      // The first real edit over an unsaved calendar event. The server call is idempotent (a retry
      // returns the same meeting and note), so this is safe to repeat after a failure.
      const target = previewTarget.current;
      if (!target) return undefined;
      const range = dayRange(target.date, target.timeZone);
      let next = await api("POST /api/v1/meetings/from-event", { body: { externalId: target.externalId, calendarId: target.calendarId, ...range, body } });
      const held = { ...pendingDetails.current };
      if (next.note && Array.isArray(held.people_ids)) {
        // Attendees the header could not show (LifeOS had no matching person yet) were just created from the
        // event; keep them when the user adds people, rather than replacing the whole list.
        const defaults = Array.isArray(next.note.frontmatter.people_ids) ? next.note.frontmatter.people_ids as string[] : [];
        held.people_ids = firstEditPeopleIds(held.people_ids as string[], defaults, headerOptions.people);
      }
      if (next.note && Object.keys(held).length) {
        // A failure here leaves a valid note with the calendar's defaults; say so rather than lose it silently.
        try {
          await api("PATCH /api/v1/notes/:id", { params: { id: next.note.frontmatter.id }, body: { changes: held, expectedHash: next.note.contentHash } });
          next = await api("GET /api/v1/meetings/:id/workspace", { params: { id: next.meeting.frontmatter.id } });
          pendingDetails.current = {};
        } catch (error) { setMessage(`Note created, but your title and links could not be applied: ${error instanceof Error ? error.message : "unknown error"}`); }
      }
      setWorkspace((current) => current && !current.note && (current.meeting.frontmatter.id === `preview:${target.externalId}` || current.meeting.frontmatter.id === next.meeting.frontmatter.id) ? next : current);
      if (previewTarget.current === target) previewTarget.current = undefined;
      // PB-027: the new meeting gets its own URL, replacing the event's, while the user is still on it.
      const here = parseRoute(locationRef.current.pathname);
      if (here?.view === "Calendar" && !here.id && !settlingNavigation.current) followRoute({ view: "Calendar", date: target.date, id: next.meeting.frontmatter.id }, { replace: true, shown: true });
      calendar.updateEvents((current) => current.map((event) => event.externalId === target.externalId && event.calendarId === target.calendarId
        ? { ...event, hasNote: Boolean(next.note), meetingId: next.meeting.frontmatter.id, noteId: next.note?.frontmatter.id }
        : event));
      createdWorkspace.current = next;
      void refresh();
      return next.note;
    }
  });

  // An editor is shown for an existing note, or for an unsaved draft over a calendar event.
  const editorReady = Boolean(workspace?.note) || meetingController.pending;
  const meetingOwner: EditorOwner | undefined = workspace?.note ? { id: workspace.note.frontmatter.id, relativePath: workspace.note.relativePath } : undefined;

  // PB-027 navigation. Every in-app move goes through `go`: it saves the open notes first, then
  // changes the URL; effects below open whatever the URL names. Back/Forward is held by the router
  // until the same save succeeds (useGuardedNavigation).
  const locationRef = useRef(location);
  locationRef.current = location;
  const guarded = useGuardedNavigation({ editors: [notesController, meetingController, seriesEditors.guard, taskEditorGuard, decisionEditorGuard, openPointEditorGuard, settingsEditorGuard], readOnly, onLeaveFailed: setMessage });
  const leaveEditors = guarded.leave;
  // While a held Back/Forward saves, nothing else may change the URL: a first save over a calendar
  // event would otherwise replace the URL with the new meeting's and release the held navigation.
  const settlingNavigation = guarded.settling;
  // A path whose item the app already put on screen itself (an opened event, a just-created meeting).
  const routeAlreadyShown = useRef<string | undefined>(undefined);
  const followRoute = (next: Route, options: { replace?: boolean; shown?: boolean } = {}) => {
    const path = routePath(next);
    if (path === (guarded.pending.current ?? `${locationRef.current.pathname}${locationRef.current.hash}`)) return;
    if (options.shown) routeAlreadyShown.current = path;
    guarded.follow(path, options);
  };
  const go = async (next: Route, options: { replace?: boolean } = {}) => {
    if (!(await leaveEditors())) return false;
    followRoute(next, options);
    return true;
  };
  function openSearch() {
    setSearchOpen(true);
    void api("GET /api/v1/calendar/day", { query: calendarSearchRange() })
      .then(setSearchCalendar)
      .catch(() => setSearchCalendar({ events: [], unavailable: true }));
  }
  /** The tab's own page, keeping the note or meeting it last had open. */
  const tabRoute = (target: View): Route => target === "Notes" ? { view: "Notes", noteTab: "open", id: selectedNoteId }
    : target === "Calendar" ? { view: "Calendar", date: selectedDate, id: workspace && workspace.persisted !== false ? workspace.meeting.frontmatter.id : undefined }
    : { view: target };
  const calendarRoute = (date: string): Route => ({ view: "Calendar", date, id: route?.view === "Calendar" ? route.id : undefined });

  const refreshWorkspace = async (meetingId: string, options: { opened?: boolean } = {}) => {
    const next = await api("GET /api/v1/meetings/:id/workspace", { params: { id: meetingId } });
    // #192: an opened meeting gets its fresh editor in the same render as its own draft. Bumped before the fetch, the
    // editor was created over the previous meeting's draft and kept showing (and saving) that text in this meeting.
    if (options.opened) { setEditorMode("visual"); setEditorSession((session) => session + 1); }
    setWorkspace(next);
    if (next.note) meetingController.open(next.note, readCachedDraft(next.note)); else if (!previewTarget.current) meetingController.reset();
  };

  useEffect(() => {
    // PB-027: the URL replaced these; drop what older versions left behind.
    try { for (const key of ["lifeos.activeView", "lifeos.activeNoteId", "lifeos.activeMeetingId"]) localStorage.removeItem(key); } catch { /* storage unavailable */ }
    Promise.all([api("GET /api/v1/connections/google").then(setGoogleConnection).catch(() => undefined), refresh()])
      .then(() => setMessage("Local workspace ready"))
      .catch((error: Error) => setMessage(error.message))
      .finally(() => setCollectionsLoaded(true));
  }, []);

  // PB-027: `/` and unknown paths go to the last page this browser showed (or Today), without a history entry.
  useEffect(() => {
    let remembered: string | null = null;
    try {
      if (route && parsedRoute && routePath(route) !== routePath(parsedRoute)) {
        localStorage.setItem(lastPathKey, routePath(route));
        followRoute(route, { replace: true });
        return;
      }
      if (route) { localStorage.setItem(lastPathKey, location.pathname); return; }
      remembered = localStorage.getItem(lastPathKey);
    } catch { /* storage unavailable: fall back to Today */ }
    if (route) return;
    followRoute(remembered && parseRoute(remembered) ? parseRoute(remembered)! : { view: "Today" }, { replace: true });
  }, [location.pathname]);

  // Re-fetch whichever note/workspace is currently open as soon as the tab regains focus, so an
  // external edit (another device, an agent, Git) is discovered immediately rather than only on
  // the next unrelated list refresh. Both fetches are the same "soft" kind used above — they only
  // update state, so useNoteDraftController's own reconcile effect on note?.contentHash decides
  // whether to resync silently or open the conflict panel. Independent of `view`: a draft stays
  // open (and its autosave keeps running) even after switching away from its editor.
  //
  // The handler reads these through refs (same pattern as activeDraft in useNoteDraftController.ts
  // and locationRef above) rather than depending on them directly: `workspace` gets a new
  // object identity on every autosave, and depending on it here would tear down and re-add the
  // document listener on that same ~1.8s cadence instead of only when a note/workspace opens or
  // closes.
  const selectedNoteIdRef = useRef(selectedNoteId);
  useEffect(() => { selectedNoteIdRef.current = selectedNoteId; }, [selectedNoteId]);
  const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  const fetchLatestNoteRef = useRef(fetchLatestNote);
  useEffect(() => { fetchLatestNoteRef.current = fetchLatestNote; }, [fetchLatestNote]);
  const fetchLatestWorkspaceRef = useRef(fetchLatestWorkspace);
  useEffect(() => { fetchLatestWorkspaceRef.current = fetchLatestWorkspace; }, [fetchLatestWorkspace]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const refetches: Promise<unknown>[] = [];
      if (selectedNoteIdRef.current) refetches.push(fetchLatestNoteRef.current());
      if (workspaceRef.current) refetches.push(fetchLatestWorkspaceRef.current());
      if (refetches.length === 0) return;
      void Promise.allSettled(refetches).then((results) => {
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) setMessage(failure.reason instanceof Error ? failure.reason.message : "Could not refresh after returning to the tab");
      });
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // PB-027: what the URL names is checked against the loaded lists; a gone item shows the list with this.
  const routeData = { notes, deletedNotes, objects: objectLinks, pendingReviewIds: reviews.filter((review) => review.frontmatter.status === "pending").map((review) => review.frontmatter.id) };
  const routeProblem = collectionsLoaded && route ? routeTarget(route, routeData) : undefined;
  const missingItem = routeProblem?.kind === "missing" ? routeProblem.message : undefined;
  const trail = collectionsLoaded && route ? buildTrail(route, { ...routeData, reviews }, { today: dateInTimeZone(new Date(), displayTimeZone), unsavedMeeting: workspace?.persisted === false }) : [];

  // PB-027: the note in the URL is the open note (on load, Back/Forward, and every in-app open).
  // This is the only place a note change primes the notes controller.
  useEffect(() => {
    if (!collectionsLoaded || route?.view !== "Notes") return;
    if (createdNoteId.current) {
      const waiting = createdNoteId.current;
      if (!route.id && route.noteTab === "open" && selectedNoteId === waiting) return;
      if (route.id) createdNoteId.current = undefined;
    }
    const target = routeTarget(route, routeData);
    if (target.kind === "redirect") { followRoute(target.route, { replace: true }); return; }
    const id = target.kind === "ok" ? route.id : undefined;
    if (route.noteTab === "deleted") { setSelectedDeletedId(id); return; }
    if (id === selectedNoteId) return;
    const note = notes.find((candidate) => candidate.frontmatter.id === id);
    if (!note) { notesController.reset(); setSelectedNoteId(undefined); return; }
    const opened = notesController.open(note, readCachedDraft(note));
    if (note.frontmatter.type === "knowledge-note") recordRecentSearchId(note.frontmatter.id);
    setSelectedNoteId(note.frontmatter.id);
    if (opened.conflict) setMessage("Recovered a browser draft, but the Markdown file also changed. Review before saving.");
  }, [location.pathname, collectionsLoaded, notes, deletedNotes]);

  // PB-027: the meeting in the URL is the open meeting. A path with no meeting closes it, so Back
  // from a meeting returns to the bare day. Runs on URL changes only, so a list refresh never
  // reopens or closes anything.
  useEffect(() => {
    if (!collectionsLoaded || route?.view !== "Calendar") return;
    if (route.date && route.date !== selectedDate) setSelectedDate(route.date);
    if (routeAlreadyShown.current === location.pathname) { routeAlreadyShown.current = undefined; return; }
    routeAlreadyShown.current = undefined;
    const current = workspaceRef.current;
    const close = () => { if (workspaceRef.current) { setWorkspace(undefined); previewTarget.current = undefined; meetingController.reset(); } };
    if (!route.id) { close(); return; }
    if (current?.meeting.frontmatter.id === route.id) return;
    const meetingId = route.id;
    void (async () => {
      // A meeting created a moment ago may not be in the object list yet; ask the server once more.
      let objects = objectLinks;
      let target = routeTarget(route, { ...routeData, objects });
      if (target.kind === "missing") { objects = await refreshObjectLinks().catch(() => objects); target = routeTarget(route, { ...routeData, objects }); }
      if (target.kind === "redirect") { followRoute(target.route, { replace: true }); return; }
      if (target.kind !== "ok") { close(); return; }
      previewTarget.current = undefined;
      await run(() => refreshWorkspace(meetingId, { opened: true }), "Meeting opened");
    })();
  }, [location.pathname, collectionsLoaded]);

  // PB-027: a task, project, decision… in the URL is highlighted on its tab, as a PB-007 link does.
  // The plain list (e.g. the breadcrumb's tab crumb, PB-026) clears the highlight.
  useEffect(() => {
    if (!collectionsLoaded || !route || route.view === "Notes" || route.view === "Calendar") return;
    setHighlightId(route.id);
    if (route.view === "Tasks" && route.id && tasks.some((task) => task.frontmatter.id === route.id)) recordRecentSearchId(route.id);
  }, [location.pathname, collectionsLoaded]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try { await action(); setMessage(success); return true; }
    catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally { setBusy(false); }
  }

  // Opening an event is a read (PB-020): it shows the existing meeting note, or an editable draft
  // over a non-persisted preview. Nothing is written until the user makes a real edit.
  // PB-027: the open note is saved first, and the opened meeting gets its own URL (an unsaved event
  // has no id yet, so it stays on the day's URL until its first edit creates the meeting).
  const openEvent = async (selectedEvent: CalendarEvent) => {
    if (!(await leaveEditors())) return false;
    // #88: offline, a stored meeting opens from LifeOS; the preview would need the calendar.
    if (selectedEvent.stored && selectedEvent.meetingId) { followRoute({ view: "Calendar", date: selectedDate, id: selectedEvent.meetingId }); return true; }
    return previewEvent(selectedEvent);
  };
  const previewEvent = (selectedEvent: CalendarEvent) => run(async () => {
    const { externalId, calendarId } = selectedEvent;
    const range = dayRange(selectedDate, displayTimeZone);
    const next = await api("GET /api/v1/meetings/preview", { query: { externalId, ...(calendarId ? { calendarId } : {}), ...range } });
    setWorkspace(next); setEditorMode("visual"); setEditorSession((current) => current + 1);
    followRoute({ view: "Calendar", date: selectedDate, id: next.persisted !== false ? next.meeting.frontmatter.id : undefined }, { shown: true });
    if (next.persisted !== false) {
      calendar.updateEvents((current) => current.map((event) => event.externalId === externalId && event.calendarId === calendarId
        ? { ...event, hasNote: Boolean(next.note), meetingId: next.meeting.frontmatter.id, noteId: next.note?.frontmatter.id }
        : event));
    }
    if (next.note) {
      previewTarget.current = undefined;
      meetingController.open(next.note, readCachedDraft(next.note));
    } else {
      // No note on disk (new event, or a meeting that never got one): editable draft, no file yet.
      const key = `event:${calendarId ?? ""}:${externalId}`;
      previewTarget.current = { externalId, calendarId, date: selectedDate, timeZone: displayTimeZone };
      pendingDetails.current = {};
      meetingController.openPending(key, readCachedPendingDraft(key));
    }
  }, "Event opened");

  // Not routed through run(): saveNow() already reports its own outcome (including a fresh
  // conflict) via onMessage, and run()'s blanket success/error message would stomp on that.
  const saveNote = async () => {
    if (!workspace?.note && !meetingController.pending) return false;
    setBusy(true);
    try {
      if (!(await meetingController.saveNow())) return false;
      if (workspace?.persisted !== false) await refreshWorkspace(workspace!.meeting.frontmatter.id);
      setMessage("Note saved to Markdown");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally { setBusy(false); }
  };

  // #62: one accept or reject per Review Item at a time, even for clicks faster than a re-render.
  const reviewRequests = useRef(reviewInFlight()).current;
  /** PB-027: once the item in the URL is accepted, rejected or deleted here, the URL drops it (no "not found" banner). */
  const leaveFinishedItem = (id: string) => {
    const here = parseRoute(locationRef.current.pathname);
    if (here?.id === id && here.view !== "Notes" && here.view !== "Calendar") followRoute({ view: here.view }, { replace: true });
  };
  const accept = (review: LifeObject) => reviewRequests.run(review.frontmatter.id, () => run(async () => {
    await api("POST /api/v1/review-items/:id/accept", { params: { id: review.frontmatter.id } });
    leaveFinishedItem(review.frontmatter.id);
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await refresh();
  }, acceptToast(review.frontmatter)));

  /** #57: like `run`, but rethrows so the link card shows the server's error itself (role=alert). */
  const reviewStep = (reviewId: string, action: () => Promise<unknown>, success: string) => reviewRequests.run(reviewId, async () => {
    setBusy(true);
    try {
      await action();
      leaveFinishedItem(reviewId);
      if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
      await refresh();
      setMessage(success);
    } finally { setBusy(false); }
  }).then(() => undefined);
  const linkActionsFor = (reviewId: string): LinkCardActions => ({
    onLink: (linkTo) => reviewStep(reviewId, () => acceptLink(api, reviewId, linkTo), "Link saved"),
    onCreate: async (type, title) => { setBusy(true); try { return await createLinkTarget(api, type, title); } finally { setBusy(false); } },
    onReject: () => reviewStep(reviewId, () => api("POST /api/v1/review-items/:id/reject", { params: { id: reviewId } }), "Proposal rejected")
  });

  const reject = (reviewId: string) => reviewRequests.run(reviewId, () => run(async () => {
    await api("POST /api/v1/review-items/:id/reject", { params: { id: reviewId } });
    leaveFinishedItem(reviewId);
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await refresh();
  }, "Proposal rejected"));

  const editReview = (reviewId: string, changes: ReviewEdits) => run(async () => {
    await api("PATCH /api/v1/review-items/:id", { params: { id: reviewId }, body: changes });
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await refresh();
  }, "Proposal updated");

  const takeOverSession = () => run(async () => {
    await api("POST /api/v1/session/take-over");
    await refresh();
  }, "This device now holds the advisory write lease");

  const createBackup = () => run(async () => {
    const created = await api("POST /api/v1/backups");
    const verification = await api("POST /api/v1/backups/:id/verify", { params: { id: created.backupId } });
    setLastVerification(verification);
    await refresh();
  }, "Snapshot created and restoration drill passed");

  const verifyBackup = (backupId: string) => run(async () => {
    setLastVerification(await api("POST /api/v1/backups/:id/verify", { params: { id: backupId } }));
  }, "Backup restoration drill completed");

  const createAndVerifyBackup = async (): Promise<BackupVerification> => {
    setBusy(true);
    try {
      const created = await api("POST /api/v1/backups");
      const verification = await api("POST /api/v1/backups/:id/verify", { params: { id: created.backupId } });
      setLastVerification(verification);
      await refresh();
      setMessage("Snapshot created and restoration drill passed");
      return verification;
    } finally { setBusy(false); }
  };

  const verifyBackupForSettings = async (backupId: string): Promise<BackupVerification> => {
    setBusy(true);
    try {
      const verification = await api("POST /api/v1/backups/:id/verify", { params: { id: backupId } });
      setLastVerification(verification);
      setMessage("Backup restoration drill completed");
      return verification;
    } finally { setBusy(false); }
  };

  const takeOverSessionForSettings = async () => {
    setBusy(true);
    try {
      await api("POST /api/v1/session/take-over");
      await refresh();
      setMessage("This device now holds the advisory write lease");
    } finally { setBusy(false); }
  };

  const submitCapture = () => run(async () => {
    await api("POST /api/v1/capture", { body: { text: capture } });
    setCapture(""); await refresh();
  }, "Captured as an Inbox task");

  const saveGlobalCapture = async (request: CaptureRequest) => {
    setBusy(true);
    try {
      const task = await api("POST /api/v1/capture", { body: request });
      await refresh();
      setMessage("Task captured");
      return task;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task capture failed");
      throw error;
    } finally { setBusy(false); }
  };

  const adoptDrafts = async () => {
    setBusy(true);
    try {
      const batch = await api("POST /api/v1/inbox/adopt");
      const count = (outcome: string) => batch.drafts.filter((draft) => draft.outcome === outcome).length;
      await refresh();
      setMessage(batch.drafts.length ? `Drafts: ${count("adopted")} adopted, ${count("applied")} patches applied, ${count("review")} sent to review, ${count("duplicate")} already adopted, ${count("failed")} failed, ${count("skipped")} still being written` : "No drafts awaiting adoption");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Adoption failed"); }
    finally { setBusy(false); }
  };

  // #44: "Enrich last 48h" writes a Work Order for Claude; the server's message says what happened.
  const requestEnrichment = async () => {
    setBusy(true);
    try {
      const result = await api("POST /api/v1/enrichment/work-orders");
      await refresh();
      setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Enrichment request failed"); }
    finally { setBusy(false); }
  };

  // #46: "Refresh" asks Claude to re-plan today by writing a replan Work Order; the brief itself is never edited here.
  const requestReplan = async () => {
    setBusy(true);
    try {
      const result = await api("POST /api/v1/focus/replan", { body: { date: dateInTimeZone(new Date(), displayTimeZone) } });
      await refresh();
      setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Re-plan request failed"); }
    finally { setBusy(false); }
  };

  // #47: pin, replace, dismiss (and undo) on today's Top 3; saved to the app-owned Focus Override with the hash we last saw.
  const changeFocus = async (change: FocusChange) => {
    const focus = today.focus;
    if (!focus) return;
    setBusy(true);
    try {
      const next = await api("POST /api/v1/focus/overrides", { body: { date: focus.date, ...change, expectedHash: focus.override?.contentHash } });
      updateToday((current) => ({ ...current, focus: next }));
      setMessage({ pin: "Pinned to today's Top 3", unpin: "Unpinned", replace: "Replaced in today's Top 3", dismiss: "Dismissed for today", restore: "Restored to today's Top 3", reset: "Your Top 3 changes for today were cleared" }[change.action]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await refresh(); setMessage("Today's Top 3 was changed on another device. The latest is loaded; make your change again."); }
      else setMessage(error instanceof Error ? error.message : "Could not change the Top 3");
    } finally { setBusy(false); }
  };

  const giveUpEnrichment = (meetingId: string) => run(async () => {
    const meeting = objectLinks.find((object) => object.frontmatter.id === meetingId);
    if (!meeting) throw new Error("Meeting not found; refresh and try again");
    await api("POST /api/v1/meetings/:id/enrichment/gave-up", { params: { id: meetingId }, body: { expectedHash: meeting.contentHash } });
    await refresh();
  }, "Stopped waiting for material for this meeting");

  const undoPatch = (patch: AppliedPatch) => run(async () => {
    await api("POST /api/v1/inbox/patches/:id/undo", { params: { id: patch.auditEventId } });
    await refresh();
  }, `Undid the change to ${patch.title}`);

  const preserveSource = async (title: string, text: string) => {
    await api("POST /api/v1/sources/text", { body: { title, text } });
    await refresh();
  };

  const connectGoogle = () => run(async () => {
    const response = await api("GET /api/v1/connections/google/start");
    window.location.assign(response.authorizationUrl);
  }, "Opening Google authorization");

  const syncGoogle = () => run(async () => {
    const day = await calendar.syncDay();
    await refresh();
    if (day.offline) throw new Error(`Google Calendar could not be synchronized: ${day.offline.error}`);
  }, "Google Calendar synchronized");

  // #88: Retry on the offline banner (Today and Calendar) reads the calendar again, without a page reload.
  // #94: success only when the calendar is back; after a Keychain denial it asks the Keychain again first.
  const retryCalendar = () => run(async () => {
    try {
      await calendar.retry({ reprobeKeychain: () => retryConnections() });
    } catch (error) {
      await refreshTodayPanels().catch(() => undefined);
      throw error;
    }
    await refreshTodayPanels();
  }, "Calendar reloaded");

  const createReferenceEntity = async (type: ReferenceEntityType, fields: Record<string, unknown>) => {
    let created: LifeObject | undefined;
    const ok = await run(async () => {
      created = await api("POST /api/v1/entities/:type", { params: { type }, body: { fields } });
      await refresh();
    }, `${type} created`);
    return ok ? created : undefined;
  };

  const createTask = async (fields: Record<string, unknown>) => {
    let created: LifeObject | undefined;
    const ok = await run(async () => {
      created = await api("POST /api/v1/entities/:type", { params: { type: "task" }, body: { fields } });
      await refresh();
    }, "task created");
    if (ok && created) followRoute({ view: "Tasks", id: created.frontmatter.id }, { replace: true });
    return ok ? created : undefined;
  };

  const updateEntity = (object: LifeObject, fields: Record<string, unknown>) => run(async () => {
    await api("PATCH /api/v1/entities/by-id/:id", { params: { id: object.frontmatter.id }, body: { fields, expectedHash: object.contentHash } });
    await refresh();
  }, `${object.frontmatter.type} updated`);

  const setPersonExternal = (object: LifeObject, choice: ExternalChoice) => run(async () => {
    await api("PUT /api/v1/people/:id/external", { params: { id: object.frontmatter.id }, body: { isExternal: externalChoiceValue(choice), expectedHash: object.contentHash } });
    await refresh();
  }, choice === "auto" ? "External flag follows the email domain again" : `Marked ${choice}`);

  // #87: confirming an automatically created person clears its "unreviewed" marker (guarded by the content hash).
  const confirmPersonReviewed = (object: LifeObject) => run(async () => {
    await api("POST /api/v1/people/:id/reviewed", { params: { id: object.frontmatter.id }, body: { expectedHash: object.contentHash } });
    await refresh();
  }, `${object.frontmatter.title} confirmed`);

  const markNotAPerson = (person: LifeObject) => run(async () => {
    await api("POST /api/v1/people/:id/not-a-person", { params: { id: person.frontmatter.id }, body: { expectedHash: person.contentHash } });
    await refresh();
  }, `${person.frontmatter.title} archived; its address is now ignored`);

  // #230: one bulk action on the selected people: one guarded write each, through the same endpoints as the
  // single-person controls, then one refresh. A failed person is named and the others still run.
  const writePerson = (action: PeopleBulkAction, person: LifeObject) => {
    const params = { id: person.frontmatter.id };
    const body = { expectedHash: person.contentHash };
    switch (action) {
      case "internal": case "external": return api("PUT /api/v1/people/:id/external", { params, body: { ...body, isExternal: action === "external" } });
      case "person": return api("POST /api/v1/people/:id/not-a-person/undo", { params, body });
      case "not-a-person": return api("POST /api/v1/people/:id/not-a-person", { params, body });
      case "confirm": return api("POST /api/v1/people/:id/reviewed", { params, body });
      case "archive": return api("POST /api/v1/objects/:id/archive", { params, body });
      case "delete": return api("DELETE /api/v1/entities/by-id/:id", { params, body });
    }
  };
  const bulkPeople = async (action: PeopleBulkAction, selected: LifeObject[]) => {
    let result: BulkResult | undefined;
    await run(async () => {
      result = await applyToEach(action, selected, (person) => writePerson(action, person));
      await refresh();
    }, "");
    if (result) setMessage(describeBulkResult(result));
    return result;
  };

  // #214: edit a person's emails. An address on another person comes back named, so the card can offer the merge.
  const addPersonEmail = async (person: LifeObject, email: string): Promise<AddEmailOutcome> => {
    const result: { outcome: AddEmailOutcome } = { outcome: { kind: "failed" } };
    const ok = await run(async () => {
      try {
        await api("POST /api/v1/people/:id/emails", { params: { id: person.frontmatter.id }, body: { email, expectedHash: person.contentHash } });
        result.outcome = { kind: "saved" };
        await refresh();
      } catch (error) {
        if (!(error instanceof ApiError && error.existingPerson)) throw error;
        result.outcome = { kind: "taken", person: error.existingPerson };
        // Reported as run's failure so "Email added" never shows for a refused address.
        throw new Error(`${email.trim().toLowerCase()} belongs to ${error.existingPerson.name}`);
      }
    }, "Email added");
    return ok || result.outcome.kind === "taken" ? result.outcome : { kind: "failed" };
  };
  const removePersonEmail = (person: LifeObject, email: string) => run(async () => {
    await api("POST /api/v1/people/:id/emails/remove", { params: { id: person.frontmatter.id }, body: { email, expectedHash: person.contentHash } });
    await refresh();
  }, "Email removed");

  // #213: Manual merge. The preview is read-only; the merge goes through the same crash-safe merge as an Inbox suggestion and answers the kept person.
  const previewPersonMerge = (person: LifeObject, choice: PersonMergeChoice) => api("GET /api/v1/people/:id/merge-preview", { params: { id: person.frontmatter.id }, query: choice });
  const mergePeople = async (person: LifeObject, choice: PersonMergeChoice) => {
    let kept: LifeObject | undefined;
    await run(async () => {
      kept = await api("POST /api/v1/people/:id/merge", { params: { id: person.frontmatter.id }, body: choice });
      await refresh();
    }, "People merged");
    return kept;
  };

  // #87: Give up from the meeting page, guarded by the meeting's own content hash.
  const giveUpMeetingEnrichment = (meeting: LifeObject) => run(async () => {
    await api("POST /api/v1/meetings/:id/enrichment/gave-up", { params: { id: meeting.frontmatter.id }, body: { expectedHash: meeting.contentHash } });
    await Promise.all([refreshWorkspace(meeting.frontmatter.id), refresh()]);
  }, "Stopped waiting for material for this meeting");

  const deleteEntity = (object: LifeObject) => run(async () => {
    await api("DELETE /api/v1/entities/by-id/:id", { params: { id: object.frontmatter.id }, body: { expectedHash: object.contentHash } });
    leaveFinishedItem(object.frontmatter.id);
    await refresh();
  }, `${object.frontmatter.type} moved to deleted state`);

  const saveGoogleSecrets = (provider: "calendar" | "drive", clientId: string, clientSecret: string) => run(async () => {
    await api("POST /api/v1/settings/connections/google/:provider", { params: { provider }, body: { clientId, clientSecret } });
    await refreshConnections();
    if (provider === "calendar") setGoogleConnection(await api("GET /api/v1/connections/google"));
  }, `Google ${provider} credentials saved to Keychain`);

  /** #77: after a denied Keychain prompt; reads the secrets again, so macOS may ask once more. */
  const retryConnections = async () => {
    await refreshConnections({ retry: true });
    void api("GET /api/v1/connections/google").then(setGoogleConnection).catch(() => undefined);
  };

  // The meeting note, creating it first if the event has none yet (inserting an image is a real edit).
  async function ensureMeetingNote(): Promise<EditorOwner | undefined> {
    const existing = workspaceRef.current?.note ?? createdWorkspace.current?.note;
    if (existing && !meetingController.pending) return { id: existing.frontmatter.id, relativePath: existing.relativePath };
    if (!(await meetingController.saveNow({ allowEmpty: true }))) return undefined;
    const created = createdWorkspace.current?.note;
    return created ? { id: created.frontmatter.id, relativePath: created.relativePath } : undefined;
  }


  // Debounced server-side search over the active tab. A blank query shows the full tab from state.
  // `ignore` drops a response that arrives after the query or tab already changed.
  useEffect(() => {
    const query = noteQuery.trim();
    if (!query && !noteFilterCount) { setNoteResults(undefined); return; }
    let ignore = false;
    const timer = window.setTimeout(() => {
      api("GET /api/v1/notes", { query: new URLSearchParams(noteListQuery(noteTab, query, noteFilters, displayTimeZone)) })
        .then((results) => { if (!ignore) setNoteResults(results); })
        .catch((error: Error) => { if (!ignore) { setNoteResults([]); setMessage(error.message); } });
    }, 200);
    return () => { ignore = true; window.clearTimeout(timer); };
  }, [noteQuery, noteTab, noteFilters, displayTimeZone, notes.length, deletedNotes.length]);

  const tabNotes = noteTab === "open" ? notes : deletedNotes;
  const noteSearching = Boolean(noteQuery.trim()) || noteFilterCount > 0;
  const visibleNotes = noteSearching ? (noteResults ?? []) : tabNotes;
  const selectedDeleted = deletedNotes.find((note) => note.frontmatter.id === selectedDeletedId);

  const restoreNote = (note: LifeObject) => run(async () => {
    const restored = await api("POST /api/v1/notes/:id/restore", { params: { id: note.frontmatter.id }, body: { expectedHash: note.contentHash } });
    await refresh();
    setSelectedDeletedId(undefined); setNoteQuery("");
    // Replaced: Back should not return to the deleted copy that no longer exists.
    followRoute({ view: "Notes", noteTab: "open", id: restored.frontmatter.id }, { replace: true });
  }, "Note restored");

  // PB-021: deleting tombstones the note (the Markdown file stays on disk, marked deleted). Confirms
  // first, and says so when unsaved text would be discarded with it.
  const deleteNote = async (note: LifeObject, controller: NoteDraftController, afterDelete: () => void) => {
    if (!window.confirm(noteDeletePrompt(note, controller.dirty))) return false;
    return run(async () => {
      await api("DELETE /api/v1/notes/:id", { params: { id: note.frontmatter.id }, body: { expectedHash: note.contentHash } });
      clearCachedDraft(note.frontmatter.id);
      controller.reset();
      afterDelete();
      await refresh();
    }, "Note deleted");
  };

  const deleteSelectedNote = () => selectedNote && deleteNote(selectedNote, notesController, () => {
    setSelectedNoteId(undefined);
    followRoute({ view: "Notes", noteTab: "open" }, { replace: true });
  });

  const deleteMeetingNote = () => workspace?.note && deleteNote(workspace.note, meetingController, () => {
    const noteId = workspace.note?.frontmatter.id;
    setWorkspace(undefined);
    followRoute({ view: "Calendar", date: selectedDate }, { replace: true });
    calendar.updateEvents((current) => current.map((event) => event.noteId === noteId ? { ...event, hasNote: false, noteId: undefined } : event));
  });

  // PB-034: "New note" opens an editor over an unsaved Standalone Note; nothing is written until the first real edit.
  const startNewNote = async () => {
    if (!(await leaveEditors())) return;
    setSelectedNoteId(undefined);
    const next = newNote.begin();
    notesController.openPending(next.key);
    followRoute({ view: "Notes", noteTab: "open" });
  };
  // An unsaved new note is dropped as soon as the URL leaves the empty Notes page (its text, if any, was saved first).
  useEffect(() => {
    if (!newNote.draft || (route?.view === "Notes" && route.noteTab === "open" && !route.id)) return;
    if (notesController.pending) notesController.reset();
    newNote.clear();
  }, [location.pathname]);
  // A header choice on an unsaved Standalone Note is the first real edit (ADR 0023): hold it, then create the note.
  // On failure the choice stays held (and on screen) with the controller's error message; the next edit retries.
  const saveNewNoteDetails = async (changes: Record<string, unknown>) => {
    newNote.hold(changes);
    await notesController.saveNow({ allowEmpty: true });
    return true;
  };
  // Inserting an image is a real edit: create the note first, then store the image against it.
  async function ensureNewNote(): Promise<EditorOwner | undefined> {
    if (!(await notesController.saveNow({ allowEmpty: true }))) return undefined;
    const created = newNote.created.current;
    return created ? { id: created.frontmatter.id, relativePath: created.relativePath } : undefined;
  }

  const saveSelectedNote = async () => {
    if (!selectedNote && !notesController.pending) return false;
    setBusy(true);
    try {
      if (!(await notesController.saveNow())) return false;
      await refresh();
      setMessage("Note saved to Markdown");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally { setBusy(false); }
  };

  // PB-007: `lifeos://` links, from both editors, the copy-link feature and the Decisions/Open Points pages.
  // Reference records (projects, clients, products, people) open inside Settings (#140).
  const { openLifeosLink } = useLifeosLinks({
    leaveEditors, refreshObjectLinks, refreshNoteLists, followRoute: (next) => followRoute(referenceRouteInSettings(next)), onMessage: setMessage, selectedDate, displayTimeZone,
    onNoteOpened: () => setNoteQuery(""), onHighlight: setHighlightId
  });
  /** #76: opens Settings and moves focus to the given card once it has rendered. */
  const openSettingsCard = async (cardId: string) => {
    await go({ view: "Settings", id: cardId });
  };
  useEffect(() => {
    if (!highlightId) return;
    const scroll = window.setTimeout(() => document.getElementById(`object-${highlightId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    const clear = window.setTimeout(() => setHighlightId(undefined), 2600);
    return () => { window.clearTimeout(scroll); window.clearTimeout(clear); };
  }, [highlightId, view]);

  // PB-006: title and relationships save on their own, apart from the body. Unsaved text is saved
  // first, so the metadata write sees the body's newest hash and the editor never mistakes it for
  // an outside edit. `busy` blocks typing while the request is in flight for the same reason.
  const saveDetails = async (controller: NoteDraftController, fetchLatest: () => Promise<{ frontmatter: { id: string }; contentHash: string } | undefined>, changes: Record<string, unknown>) => {
    if (controller.dirty && !(await controller.saveNow())) return false;
    return run(async () => {
      const latest = await fetchLatest();
      if (!latest) throw new Error("This note no longer exists");
      await api("PATCH /api/v1/notes/:id", { params: { id: latest.frontmatter.id }, body: { changes, expectedHash: latest.contentHash } });
      await fetchLatest();
      await refresh();
    }, "Note details saved");
  };
  const saveNotesDetails = (changes: Record<string, unknown>) => saveDetails(notesController, fetchLatestNote, changes);
  const saveMeetingNoteDetails = (changes: Record<string, unknown>) => saveDetails(meetingController, fetchLatestWorkspace, changes);
  const labels = labelMap(personLabels);
  const headerOptions = { projects: entityOptions(projects.map(({ project }) => project)), clients: entityOptions(clients.map(({ entity }) => entity)), products: entityOptions(products.map(({ entity }) => entity)), people: people.map(({ entity }) => personOption(labels, entity)) };

  // The header of a note that does not exist yet: the event's own project, client, product and
  // attendees are shown when they match an object LifeOS already has (attendees by id, the rest by name), and the rest stay
  // blank until the first edit creates them. The id and hash are fixed so the form is not re-seeded.
  const pendingHeaderNote = (current: Workspace) => {
    const match = (options: { id: string; title: string }[], object?: LifeObject) => object ? options.find((option) => foldText(option.title) === foldText(object.frontmatter.title))?.id ?? "" : "";
    return {
      contentHash: PENDING_NOTE_HASH,
      frontmatter: {
        id: current.meeting.frontmatter.id, type: "meeting-note", title: `${current.meeting.frontmatter.title} notes`,
        primary_project_id: match(headerOptions.projects, current.context.project), primary_client_id: match(headerOptions.clients, current.context.client), primary_product_id: match(headerOptions.products, current.context.product),
        people_ids: headerPeopleIds(headerOptions.people, current.context.people)
      }
    };
  };

  // "Keep browser version" / "Keep disk version" for both editors now live on their respective
  // controller (useNoteDraftController.ts) — wrapped with `busy` here since only the caller knows
  // when a click, rather than autosave, is in flight.
  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  }

  const pendingReviews = reviews.filter((review) => review.frontmatter.status === "pending");

  const feedback = useAppFeedback({ page: view, openObjectId: route?.id, knownObjectIds: objectLinks.map((object) => object.frontmatter.id) });

  return <ApplicationShell
    activeView={view}
    pendingReviewCount={pendingReviews.length}
    status={readOnly ? (releasedAfterIdle ? "Read-only · paused after inactivity" : "Read-only · another device active") : message}
    readOnly={readOnly}
    onNavigate={(item) => void go(tabRoute(item))}
    onSearch={openSearch}
    onCapture={() => setCaptureOpen(true)}
    onFeedback={feedback.open}
  >
      <FeedbackDialog {...feedback.dialog} />
      {feedback.toast && <div className="feedback-toast" role="status">{feedback.toast}</div>}
      <GlobalSearchOverlay open={searchOpen} tasks={tasks} notes={notes} calendar={searchCalendar.events} calendarOffline={searchCalendar.offline} calendarUnavailable={searchCalendar.unavailable} timeZone={displayTimeZone} onClose={() => setSearchOpen(false)} onOpen={(target) => void go(target)} />
      <OverlayDialog open={captureOpen} label="Global Capture" onClose={() => setCaptureOpen(false)}>
        <header className="global-search-header"><div><span>GLOBAL CAPTURE</span><h2>Capture a task</h2></div><button type="button" aria-label="Close Capture" onClick={() => setCaptureOpen(false)}>×</button></header>
        <CapturePanel projects={projects.map(({ project }) => ({ id: project.frontmatter.id, title: project.frontmatter.title }))} owners={people.map(({ entity }) => ({ id: entity.frontmatter.id, title: entity.frontmatter.title }))} selfId={people.find(({ entity }) => entity.frontmatter.is_self === true)?.entity.frontmatter.id} busy={busy} readOnly={readOnly} onSave={saveGlobalCapture} onViewTask={(id) => { setCaptureOpen(false); void go({ view: "Tasks", id }); }} />
      </OverlayDialog>
      <Breadcrumbs trail={trail} onGo={(next) => void go(next)} />
      {!server.online && <article className="lease-warning" role="status"><span>LIFEOS SERVER</span><h3>Reconnecting…</h3><p>LifeOS is restarting or not running. Keep typing: your draft is kept in the browser and saves when the server is back.</p></article>}
      <AppStatusBanners session={health?.session} idleMinutes={health?.idleReleaseMinutes} offline={calendar.offline} busy={busy} timeZone={displayTimeZone} onTakeOver={takeOverSessionForSettings} onRetryCalendar={async () => { await retryCalendar(); }} />
      {missingItem && <article className="lease-warning" role="status"><span>NOT FOUND</span><p>{missingItem} Showing the {view === "Calendar" ? "day" : "list"} instead.</p></article>}
      {view === "Today" && <TodayPage today={today} panels={todayPanels} enrichment={enrichment} eventCount={calendar.events.length} capture={capture} busy={busy} readOnly={readOnly} loading={!collectionsLoaded} onCaptureChange={setCapture} onCapture={submitCapture} onReplan={requestReplan} onChangeFocus={changeFocus} onEnrich={requestEnrichment} onGiveUp={giveUpEnrichment} onOpenInbox={() => void go({ view: "Inbox" })} onOpenSettingsCard={openSettingsCard} onCompleteTask={(task) => updateEntity(task, { status: "Done" })} onOpenTasks={() => void go({ view: "Tasks" })} onOpenCalendar={() => void go(tabRoute("Calendar"))} timeZone={displayTimeZone} onRetryCalendar={() => void retryCalendar()} onBackUpNow={createBackup} />}

      {view === "Calendar" && <>
        <PageHeader eyebrow="CALENDAR / MEETING" title="Meeting workspace" description="Capture in Markdown, review proposed commitments, and publish only what you confirm." />
        {googleConnection?.reason === "expired" && <article className="lease-warning" role="alert"><span>GOOGLE CALENDAR</span><h3>Reconnect Google Calendar</h3><p>Google no longer accepts the saved access, so events cannot sync. {googleConnection.lastSuccessfulSyncAt ? `Last successful sync: ${new Date(googleConnection.lastSuccessfulSyncAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone })}.` : "No successful sync recorded yet."}</p><button className="takeover" disabled={busy} onClick={connectGoogle}>Reconnect</button></article>}
        {googleConnection && !googleConnection.connected && googleConnection.reason !== "expired" && <article className="lease-warning"><span>GOOGLE CALENDAR</span><h3>{googleConnection.configured ? "Ready to connect" : "Configuration required"}</h3><p>{googleConnection.configured ? "Authorize read-only access to replace the mock calendar with your upcoming events." : "Add the Google Calendar OAuth client under Settings, then return here to connect."}</p>{googleConnection.configured ? <button className="takeover" disabled={busy} onClick={connectGoogle}>Connect Google Calendar</button> : <button onClick={() => void go({ view: "Settings" })}>Open Settings</button>}</article>}
        {googleConnection?.connected && <article className="connection-card"><span>GOOGLE CALENDAR CONNECTED</span><p className="muted">Read-only access is active. Each manual sync records a durable Sync Run.</p><button disabled={busy || readOnly} onClick={syncGoogle}>Sync now</button></article>}
        <CalendarWorkspace
          selectedDate={selectedDate}
          displayTimeZone={displayTimeZone}
          events={calendar.filteredEvents}
          offline={calendar.offline}
          error={calendar.error}
          loading={calendar.loading}
          filter={calendar.filter}
          offered={calendar.offered}
          busy={busy}
          readOnly={readOnly}
          detailOpen={Boolean(workspace)}
          detailKey={workspace?.meeting.frontmatter.id}
          onPreviousDay={() => void go(calendarRoute(addCalendarDays(selectedDate, -1)))}
          onToday={() => void go(calendarRoute(dateInTimeZone(new Date(), displayTimeZone)))}
          onNextDay={() => void go(calendarRoute(addCalendarDays(selectedDate, 1)))}
          onDateChange={(date) => void go(calendarRoute(date))}
          onFilterChange={calendar.setFilter}
          onRetry={() => void retryCalendar()}
          onSelectEvent={(event) => void openEvent(event)}
          onBack={() => void go({ view: "Calendar", date: selectedDate })}
        >
            {!workspace ? <article className="empty-state"><h3>Select a meeting</h3><p>Open an event to resume its canonical note or start a new one. Nothing is saved until you edit.</p></article> : <>
              <article className="meeting-header">
                <div><span>MEETING</span><h3>{workspace.meeting.frontmatter.title}</h3><CopyLink object={workspace.persisted !== false ? workspace.meeting : undefined} />{workspace.persisted !== false && <HistoryLink objectId={workspace.meeting.frontmatter.id} title={workspace.meeting.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={() => refreshWorkspace(workspace.meeting.frontmatter.id)} />}{/* #86: the meeting itself can be restricted; a restricted note restricts it too (#63). A preview has no file yet. */}{workspace.persisted !== false && <SensitivityToggle object={workspace.meeting} noun="meeting" restrictedByNote={Boolean(workspace.note && isRestricted(workspace.note.frontmatter))} disabled={busy || readOnly} run={run} onChanged={async () => { await fetchLatestWorkspace(); }} note={workspace.note && isRestricted(workspace.note.frontmatter) && !isRestricted(workspace.meeting.frontmatter) ? "Its note is restricted, so this meeting is kept away from Agents and Work Orders too." : undefined} />}</div>
                <div className="context-grid">
                  <Meta label="When" value={workspace.meeting.frontmatter.is_all_day === true ? `${String(workspace.meeting.frontmatter.starts_at).slice(0, 10)} · All day` : formatDate(workspace.meeting.frontmatter.starts_at)} />
                  <Meta label="Project" value={workspace.context.project?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Client" value={workspace.context.client?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Product" value={workspace.context.product?.frontmatter.title ?? "Not linked"} />
                  <PeopleMeta label="Attendees" people={workspace.context.people} labels={labels} empty="None" />
                </div>
                {workspace.persisted !== false && <MeetingEnrichment title={workspace.meeting.frontmatter.title} frontmatter={workspace.meeting.frontmatter} disabled={busy || readOnly} onGiveUp={() => void giveUpMeetingEnrichment(workspace.meeting)} />}
              </article>
              {workspace.note && meetingController.conflict ? <NoteConflictPanel noteTitle={workspace.note.frontmatter.title} draftText={meetingController.draft} diskText={workspace.note.body} disabled={busy || readOnly} onKeepBrowserVersion={() => withBusy(meetingController.keepBrowserVersion)} onKeepDiskVersion={() => withBusy(meetingController.keepDiskVersion)} /> :
              <EditorFrame>
                {workspace.note
                  ? <NoteHeader note={workspace.note} kind="CANONICAL NOTE" {...headerOptions} disabled={busy || readOnly || meetingController.autoSaving} onSave={saveMeetingNoteDetails}><ModeSwitch mode={editorMode} onChange={setEditorMode} visualDisabled={hasRawAnchorLines(meetingController.draft)} /><HistoryLink objectId={workspace.note.frontmatter.id} title={workspace.note.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={() => refreshWorkspace(workspace.meeting.frontmatter.id)} /></NoteHeader>
                  : <NoteHeader note={pendingHeaderNote(workspace)} kind={workspace.seriesView ? "NEW OCCURRENCE" : "NEW NOTE"} {...headerOptions} disabled={busy || readOnly} onSave={async (changes) => { pendingDetails.current = { ...pendingDetails.current, ...changes }; return true; }}><ModeSwitch mode={editorMode} onChange={setEditorMode} /></NoteHeader>}
                <MarkdownEditor mode={editorMode} editorKey={`meeting:${editorSession}`} draft={meetingController.draft} onChange={meetingController.setDraftFor(meetingController.target)} readOnly={readOnly} busy={busy} ready={editorReady} owner={meetingOwner} ensureOwner={ensureMeetingNote} linkObjects={objectLinks} setBusy={setBusy} notify={setMessage} onImageStored={refresh} placeholder="Capture meeting notes… Paste or drop an image here." codeLanguagePrompt="Code language (for example: typescript, python, sql)" caretAfterInsert={false} refocusAfterImage />
                <div className="editor-footer">
                  <SaveState dirty={meetingController.dirty} autoSaving={meetingController.autoSaving} pending={meetingController.pending} undoAvailable={meetingController.undoAvailable} undoDisabled={busy || readOnly} onUndo={() => withBusy(meetingController.undoKeepDiskVersion)} />
                  <MeetingNoteActions canDelete={Boolean(workspace.note)} deleteDisabled={busy || readOnly || meetingController.autoSaving} saveDisabled={!editorReady || busy || !meetingController.dirty || readOnly} onDelete={deleteMeetingNote} onSave={saveNote} />
                </div>
                {workspace.note && <div className="metadata-strip"><Meta label="Created" value={formatDate(workspace.note.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(workspace.note.frontmatter.updated_at)} /><Meta label="Revision" value={String(workspace.note.frontmatter.revision)} /><Meta label="File" value={workspace.note.relativePath} /></div>}
              </EditorFrame>}
              {workspace.seriesView && <SeriesView key={workspace.meeting.frontmatter.id} view={workspace.seriesView} timeZone={displayTimeZone} editor={{ mode: editorMode, readOnly, linkObjects: objectLinks, notify: setMessage, register: seriesEditors.register }} onOpenMeeting={(meetingId, date) => void go({ view: "Calendar", date, id: meetingId })} />}
              {/* #45: the accepted AI summary lives in the meeting body, apart from the user's own note. */}
              {meetingSummary(workspace.meeting.body) && <article><span>AI SUMMARY</span><h3>Summary</h3><div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{meetingSummary(workspace.meeting.body)!}</ReactMarkdown></div></article>}
              <article><span>REVIEW BEFORE PUBLISHING</span><h3>Meeting proposals</h3>
                {!workspace.reviews.length && <p className="muted">Process the note to create a durable review item.</p>}
                {workspace.reviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} labels={labels} linkActions={linkActionsFor(review.frontmatter.id)} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} />)}
              </article>
            </>}
        </CalendarWorkspace>
      </>}

      {view === "Notes" && <NotesWorkspace
        notes={visibleNotes}
        openCount={notes.length}
        deletedCount={deletedNotes.length}
        tab={noteTab}
        selectedId={noteTab === "open" ? selectedNoteId : selectedDeletedId}
        query={noteQuery}
        filters={noteFilters}
        projects={entityOptions(projects.map(({ project }) => project))}
        clients={entityOptions(clients.map(({ entity }) => entity))}
        products={entityOptions(products.map(({ entity }) => entity))}
        people={entityOptions(people.map(({ entity }) => entity))}
        timeZone={displayTimeZone}
        loading={!collectionsLoaded}
        readOnly={readOnly}
        conflictedNoteIds={conflictedNoteIds}
        emptyMessage={emptyNotesMessage(noteTab, noteQuery, noteFilters)}
        creating={Boolean(newNote.draft)}
        onNewNote={() => void startNewNote()}
        detailState={noteTab === "deleted" ? (selectedDeleted ? "deleted" : "empty") : selectedNote && notesController.conflict ? "conflict" : selectedNote || newNote.draft ? "open" : "empty"}
        onQueryChange={setNoteQuery}
        onFiltersChange={setNoteFilters}
        onTabChange={(tab) => void go({ view: "Notes", noteTab: tab, id: tab === "open" ? selectedNoteId : selectedDeletedId })}
        onOpen={(id) => void go({ view: "Notes", noteTab, id })}
        onBack={() => void go({ view: "Notes", noteTab })}
        deletedDetail={!selectedDeleted ? null : <article className="editor-card">
              <div className="editor-heading"><div><span>DELETED {selectedDeleted.frontmatter.type.replace("-", " ").toUpperCase()}</span><h3>{selectedDeleted.frontmatter.title}</h3></div></div>
              <MarkdownPreview markdown={selectedDeleted.body} empty="_Empty note._" />
              <div className="editor-footer"><div className="save-state"><i className="dirty" />Deleted {formatDate(String(selectedDeleted.frontmatter.deleted_at))} · read-only</div><div className="actions"><PermanentDeleteButton key={selectedDeleted.frontmatter.id} note={selectedDeleted} disabled={busy || readOnly} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onDeleted={async (deleted) => { if (deleted) setSelectedDeletedId(undefined); await refresh(); }} /><button className="primary" disabled={busy || readOnly} onClick={() => restoreNote(selectedDeleted)}>Restore note</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedDeleted.frontmatter.created_at)} /><Meta label="Deleted" value={formatDate(String(selectedDeleted.frontmatter.deleted_at))} /><Meta label="Revision" value={String(selectedDeleted.frontmatter.revision)} /><Meta label="File" value={selectedDeleted.relativePath} /></div>
            </article>}
        conflictDetail={selectedNote && notesController.conflict ? <NoteConflictPanel noteTitle={selectedNote.frontmatter.title} draftText={notesController.draft} diskText={selectedNote.body} disabled={busy || readOnly} onKeepBrowserVersion={() => withBusy(notesController.keepBrowserVersion)} onKeepDiskVersion={() => withBusy(notesController.keepDiskVersion)} /> : null}
        renderOpenNote={(notesMode) => !selectedNote ? (newNote.draft ? <EditorFrame>
              <NoteHeader note={{ contentHash: PENDING_NOTE_HASH, frontmatter: { id: newNote.draft.id, type: "standalone-note", title: newNote.draft.title } }} kind="NEW NOTE" {...headerOptions} disabled={busy || readOnly} onSave={saveNewNoteDetails} />
              <MarkdownEditor mode={notesMode} editorKey={newNote.draft.id} draft={notesController.draft} onChange={notesController.setDraftFor(notesController.target)} readOnly={readOnly} busy={busy} ensureOwner={ensureNewNote} linkObjects={objectLinks} setBusy={setBusy} notify={setMessage} placeholder="Write Markdown… Paste or drop an image here." codeLanguagePrompt="Code language" caretAfterInsert refocusAfterImage={false} />
              <div className="editor-footer"><SaveState dirty={notesController.dirty} autoSaving={notesController.autoSaving} pending={notesController.pending} undoAvailable={false} undoDisabled onUndo={() => undefined} /><div className="actions"><button className="primary" disabled={busy || readOnly || !notesController.dirty} onClick={saveSelectedNote}>Save now</button></div></div>
            </EditorFrame> : null) : <EditorFrame>
              <NoteHeader note={selectedNote} kind={selectedNote.frontmatter.type.replace("-", " ").toUpperCase()} {...headerOptions} disabled={busy || readOnly || notesController.autoSaving} onSave={saveNotesDetails}><HistoryLink objectId={selectedNote.frontmatter.id} title={selectedNote.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={refresh} /></NoteHeader>
              {seriesRoute && <p className="series-link"><a href={routePath(seriesRoute)} onClick={(event) => { event.preventDefault(); followRoute(seriesRoute); }}>Show series</a></p>}
              <MarkdownEditor mode={notesMode} editorKey={selectedNote.frontmatter.id} draft={notesController.draft} onChange={notesController.setDraftFor(selectedNote.frontmatter.id)} readOnly={readOnly} busy={busy} owner={{ id: selectedNote.frontmatter.id, relativePath: selectedNote.relativePath }} linkObjects={objectLinks} setBusy={setBusy} notify={setMessage} placeholder="Write Markdown… Paste or drop an image here." codeLanguagePrompt="Code language" caretAfterInsert refocusAfterImage={false} />
              <div className="editor-footer"><SaveState dirty={notesController.dirty} autoSaving={notesController.autoSaving} undoAvailable={notesController.undoAvailable} undoDisabled={busy || readOnly} onUndo={() => withBusy(notesController.undoKeepDiskVersion)} /><div className="actions"><button className="danger" disabled={busy || readOnly || notesController.autoSaving} onClick={deleteSelectedNote}>Delete note</button><button className="primary" disabled={busy || readOnly || !notesController.dirty} onClick={saveSelectedNote}>Save now</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedNote.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(selectedNote.frontmatter.updated_at)} /><Meta label="Revision" value={String(selectedNote.frontmatter.revision)} /><Meta label="File" value={selectedNote.relativePath} /></div>
            </EditorFrame>}
      />}

      {view === "Tasks" && <TaskWorkspace tasks={withOpenedArchived(tasks, objectLinks as LinkedObject[], "task", route?.view === "Tasks" ? route.id : undefined) as LifeObject[]} linkables={objectLinks} labels={labels} projects={projects.map(({ project }) => ({ id: project.frontmatter.id, title: String(project.frontmatter.title) }))} selfId={people.find(({ entity }) => entity.frontmatter.is_self === true)?.entity.frontmatter.id} selectedId={route?.view === "Tasks" ? route.id : undefined} today={dateInTimeZone(new Date(), displayTimeZone)} timeZone={displayTimeZone} guard={taskEditorGuard} busy={busy} readOnly={readOnly} run={run} onOpen={(id) => followRoute({ view: "Tasks", id })} onCloseDetail={() => followRoute({ view: "Tasks" })} onCreate={createTask} onSave={updateEntity} onDelete={deleteEntity} onComplete={(task, complete) => updateEntity(task, { status: complete ? "Done" : "Next" })} onRestored={refresh} />}

      {view === "Decisions" && <DecisionsPage projects={projects.map(({ project }) => project)} clients={clients.map(({ entity }) => entity)} products={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} timeZone={displayTimeZone} highlightId={highlightId} guard={decisionEditorGuard} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onChanged={refresh} formatDate={formatDate} />}
      {view === "Open Points" && <OpenPointsPage projects={projects.map(({ project }) => project)} clients={clients.map(({ entity }) => entity)} products={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} timeZone={displayTimeZone} highlightId={highlightId} guard={openPointEditorGuard} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onChanged={refresh} formatDate={formatDate} />}

      {view === "Inbox" && <>
        <article className="inbox-drafts"><span>AGENT DRAFTS</span><div className="capture-row"><p>{awaitingAdoptionLabel(inboxDrafts)}</p><button className="primary" disabled={busy || readOnly} onClick={() => void adoptDrafts()}>Adopt now</button></div>
          {inboxDrafts.failed.length > 0 && <><p>Failed drafts are kept in <code>_inbox/failed/</code>. Fix and re-send them, or remove the file.</p><ul className="diagnostics">{inboxDrafts.failed.map((entry) => <li key={entry.path}>{entry.reason}</li>)}</ul></>}</article>
        {appliedPatches.length > 0 && <article className="inbox-drafts"><span>APPLIED CHANGES</span><ul className="diagnostics">{appliedPatches.slice(0, 20).map((patch) => <li key={patch.auditEventId}><div className="capture-row"><p><b>{patch.title}</b>: {[...Object.keys(patch.after).map((field) => `${field} ${String(patch.before[field] ?? "none")} → ${String(patch.after[field] ?? "none")}`), ...(patch.appendedNote ? [`note added: "${patch.appendedNote}"`] : [])].join("; ") || "no change"}</p>{patch.undone ? <em>Undone</em> : <button disabled={busy || readOnly} onClick={() => void undoPatch(patch)}>Undo</button>}</div></li>)}</ul></article>}
        <InboxWorkspace
          reviews={pendingReviews}
          objects={objectLinks}
          labels={labels}
          choices={headerOptions}
          selectedId={route?.view === "Inbox" ? route.id : undefined}
          loading={!collectionsLoaded}
          busy={busy}
          readOnly={readOnly}
          displayTimeZone={displayTimeZone}
          onOpen={(id, options) => void go({ view: "Inbox", id }, options)}
          onBack={() => void go({ view: "Inbox" })}
          onAccept={accept}
          onReject={(review) => reject(review.frontmatter.id)}
          onSave={(review, changes) => editReview(review.frontmatter.id, changes)}
          linkActionsFor={linkActionsFor}
        />
      </>}

      {view === "Knowledge" && <KnowledgeWorkspace
        notes={knowledge}
        sources={objectLinks.filter((object): object is LifeObject => object.frontmatter.type === "source" && "body" in object)}
        projects={projects.map(({ project }) => ({ id: project.frontmatter.id, title: project.frontmatter.title }))}
        people={people.map(({ entity }) => ({ id: entity.frontmatter.id, title: personLabel(labels, entity).label }))}
        selectedId={route?.view === "Knowledge" ? route.id : undefined}
        loading={!collectionsLoaded}
        readOnly={readOnly}
        displayTimeZone={displayTimeZone}
        onOpen={(id) => void go({ view: "Knowledge", id })}
        onBack={() => void go({ view: "Knowledge" })}
        onPreserve={preserveSource}
      />}

      {view === "System" && <><PageHeader eyebrow="SYSTEM" title="Health and device handoff" description="Integrity checks and an advisory lease protect the Markdown root during sequential two-device use." />
        <AboutLifeOS server={health?.appInfo} timeZone={displayTimeZone} />
        <div className="summary">
          <Summary label="Object graph" value={health?.diagnostics.length ? "Attention" : "Healthy"} detail={`${health?.objectCount ?? 0} indexed objects`} />
          <Summary label="Write access" value={readOnly ? "Read-only" : "Enabled"} detail={readOnly ? (releasedAfterIdle ? "released after inactivity" : "another device lease is active") : "revision checks remain active"} />
          <Summary label="Device" value={health?.session.currentDeviceId ?? "—"} detail="this installation" />
        </div>
        <SelfEmailWarning warning={health?.setupWarning} onOpenSettings={openSettingsCard} />
        <BackupWarning warning={health?.backupWarning} disabled={busy || readOnly} onBackUpNow={createBackup} />
        {readOnly && !releasedAfterIdle && <article className="lease-warning"><span>DEVICE HANDOFF REQUIRED</span><h3>{health?.session.activeDeviceId} is still active</h3><p>{health?.session.warning}</p><p>{takeoverCaution}</p><button className="takeover" disabled={busy} onClick={takeOverSession}>Take over write access</button></article>}
        <div className="system-grid">
          <article><span>SESSION LEASE</span><div className="system-details"><Meta label="Active device" value={health?.session.activeDeviceId ?? "—"} /><Meta label="Started" value={formatDate(health?.session.startedAt)} /><Meta label="Last activity" value={formatDate(health?.session.lastActivityAt)} /><Meta label="Lease expires" value={formatDate(health?.session.leaseExpiresAt)} /></div></article>
          <article><span>INTEGRITY DIAGNOSTICS</span>{!health?.diagnostics.length ? <div className="health-ok"><i />No duplicate IDs, broken links, type mismatches, or duplicate canonical notes.</div> : <ul className="diagnostics">{health.diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul>}</article>
        </div>
        <article className="backup-panel"><div className="backup-heading"><div><span>VERSIONED BACKUPS</span><h3>Snapshots and restoration drills</h3></div><button className="takeover" disabled={busy || readOnly} onClick={createBackup}>Create & verify snapshot</button></div>
          <p className="muted">Snapshots contain Markdown, assets, and a SHA-256 manifest. The live device lease and secrets are excluded.</p>
          {lastVerification && <div className={lastVerification.valid ? "verification valid" : "verification invalid"}><b>{lastVerification.valid ? "Restoration drill passed" : "Verification failed"}</b><span>{lastVerification.fileCount} files · {formatBytes(lastVerification.totalBytes)} · temporary restore {lastVerification.restoredToTemporaryDirectory ? "completed" : "not attempted"}</span>{lastVerification.diagnostics.map((item) => <small key={item}>{item}</small>)}</div>}
          {!backups.length ? <p className="muted">No snapshots have been created yet.</p> : <div className="backup-list">{backups.map((backup) => <div className="backup-row" key={backup.backupId}><div><b>{formatDate(backup.createdAt)}</b><small>{backup.fileCount} files · {formatBytes(backup.totalBytes)}</small><code>{backup.backupId}</code></div><button disabled={busy} onClick={() => verifyBackup(backup.backupId)}>Test restore</button></div>)}</div>}
        </article>
        <article className="handoff"><span>SAFE HANDOFF</span><ol><li>Finish and close LifeOS on this computer.</li><li>Wait until Google Drive reports synchronization complete.</li><li>On the other computer, wait for incoming sync to finish.</li><li>Start LifeOS and confirm System Health before editing.</li></ol></article>
      </>}

      {view === "Settings" && <SettingsPage
        displayTimeZone={displayTimeZone}
        onDisplayTimeZoneChange={(zone) => { localStorage.setItem("lifeos.displayTimeZone", zone); setDisplayTimeZone(zone); return true; }}
        calendarCatalog={calendar.catalog}
        calendarCatalogLoaded={calendar.catalogLoaded}
        calendarPrefs={calendar.prefs}
        onLoadCalendars={calendar.loadCatalog}
        onSaveCalendarPrefs={calendar.savePrefs}
        connections={connections}
        onRetryConnections={retryConnections}
        busy={busy}
        readOnly={readOnly}
        onSaveGoogleSecrets={saveGoogleSecrets}
        onChanged={refresh}
        health={health}
        backups={backups}
        lastVerification={lastVerification}
        onCreateAndVerifyBackup={createAndVerifyBackup}
        onVerifyBackup={verifyBackupForSettings}
        onTakeOverSession={takeOverSessionForSettings}
        guard={settingsEditorGuard}
        selectedCardId={referenceCardIdFromRoute(route?.view === "Settings" ? route.id : undefined)}
        onOpenCard={(id) => followRoute({ view: "Settings", id })}
        referenceSections={(Object.entries({ project: projects.map(({ project }) => project), client: clients.map(({ entity }) => entity), product: products.map(({ entity }) => entity), person: people.map(({ entity }) => entity) }) as Array<[ReferenceEntityType, LifeObject[]]>).map(([type, objects]): SettingsSection => {
          const plural = type === "person" ? "people" : `${type}s`;
          const label = plural[0]!.toUpperCase() + plural.slice(1);
          const selection = parseReferenceSettingsId(route?.view === "Settings" ? route.id : undefined);
          return { id: `reference-${plural}`, group: "Reference data", label, cards: [{ id: referenceSettingsCardId(type), label, safeNames: objects.map((object) => object.frontmatter.title), content: <ReferenceDataSettings type={type} objects={objects} linkables={objectLinks} personLabels={labels} selectedId={selection?.type === type ? selection.recordId : undefined} busy={busy} readOnly={readOnly} onOpen={(id) => followRoute({ view: "Settings", id: referenceSettingsId(type, id) })} onCreate={createReferenceEntity} onSave={updateEntity} onDelete={deleteEntity} onSetExternal={type === "person" ? setPersonExternal : undefined} onConfirmReviewed={type === "person" ? confirmPersonReviewed : undefined} onNotAPerson={type === "person" ? markNotAPerson : undefined} onPreviewMerge={type === "person" ? previewPersonMerge : undefined} onMergePeople={type === "person" ? mergePeople : undefined} onAddEmail={type === "person" ? addPersonEmail : undefined} onRemoveEmail={type === "person" ? removePersonEmail : undefined} notAPersonPeople={type === "person" ? notAPersonPeople : undefined} onBulkPeople={type === "person" ? bulkPeople : undefined} run={run} onRestored={refresh} /> },
            ...(type === "person" ? [{ id: "settings-people-duplicates", label: "Clean up duplicates", content: <DuplicateCleanupCard disabled={readOnly || busy} onLoad={() => api("GET /api/v1/people/duplicates")} onApply={(choice) => api("POST /api/v1/people/duplicates/clean-up", { body: choice })} onApplied={() => void refresh()} /> }] : [])] };
        })}
      />}
  </ApplicationShell>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta"><small>{label}</small><b title={value}>{value}</b></div>;
}
/** #39: comma-separated display labels, with the red " - ext" marker kept as text. */
function PeopleList({ people, labels }: { people: LifeObject[]; labels: Map<string, PersonLabel> }) {
  return <>{people.map((person, index) => <React.Fragment key={person.frontmatter.id}>{index > 0 && ", "}<PersonName {...personLabel(labels, person)} /></React.Fragment>)}</>;
}
function PeopleMeta({ label, people, labels, empty }: { label: string; people: LifeObject[]; labels: Map<string, PersonLabel>; empty: string }) {
  const text = people.map((person) => personLabel(labels, person).label).join(", ") || empty;
  return <div className="meta"><small>{label}</small><b title={text}>{people.length ? <PeopleList people={people} labels={labels} /> : empty}</b></div>;
}
const router = createBrowserRouter([{ path: "*", element: <App /> }]);
createRoot(document.getElementById("root")!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>);
