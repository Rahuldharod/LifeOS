import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useLocation } from "react-router";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
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
import { EnvelopeBadges } from "./EnvelopeBadges.js";
import { areaOptions, isRestricted } from "./envelope.js";
import { entityOptions, foldText } from "./searchOptions.js";
import { lifeosLinkId, resolveLifeosLink, withOpenedArchived, type LinkedObject } from "./lifeosLinks.js";
import { addCalendarDays, dateInTimeZone, dayRange } from "./zonedTime.js";
import { DecisionsPage } from "./DecisionsPage.js";
import { activeNoteFilterCount, emptyNotesMessage, noNoteFilters, noteListQuery } from "./noteFilters.js";
import { externalChoiceOf, externalChoiceValue, labelMap, personLabel, personOption, type ExternalChoice } from "./personLabels.js";
import { PersonName } from "./PersonName.js";
import { MeetingEnrichment } from "./MeetingEnrichment.js";
import { PersonReviewControl } from "./PersonReview.js";
import { OpenPointsPage } from "./OpenPointsPage.js";
import { HistoryLink } from "./HistoryPanel.js";
import { CopyLink } from "./CopyLink.js";
import { objectLinkMarkdown } from "./objectLinkMarkdown.js";
import { markdownPasteAction } from "./markdownPaste.js";
import { pasteLifeosLink } from "./visualLinkPaste.js";
import { awaitingAdoptionLabel } from "./todayPanels.js";
import { LinkResolutionCard, type LinkCardActions } from "./LinkResolutionCard.js";
import { acceptLink, acceptToast, createLinkTarget } from "./linkResolution.js";
import { reviewInFlight } from "./reviewInFlight.js";
import { displayTimeZone as storedDisplayTimeZone, formatDate } from "./dateFormat.js";
import { contextLinkFields, entityLinkFields } from "@lifeos/shared";
import { EntityLinkPicker, type Linkable } from "./EntityLinkPicker.js";
import { PageHeader, Summary, objectRow } from "./pageParts.js";
import { TodayPage } from "./TodayPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { createSettingsEditorGuard, type SettingsSection } from "./SettingsWorkspace.js";
import { ReferenceDataSettings } from "./ReferenceDataSettings.js";
import { parseReferenceSettingsId, referenceCardIdFromRoute, referenceRouteInSettings, referenceSettingsCardId, referenceSettingsId, type ReferenceEntityType } from "./referenceSettingsRoutes.js";
import { SelfEmailWarning } from "./SelfEmailWarning.js";
import { MeetingNoteActions } from "./MeetingNoteActions.js";
import { lostImages, roundTripReport, storedMarkdown, visualEditorFeatures, visualMarkdown, type RoundTripReport } from "./editorMarkdown.js";
import { UnprovenFormattingLabel } from "./UnprovenFormattingLabel.js";
import { ImageLossNotice } from "./ImageLossNotice.js";
import { takeoverCaution } from "./LeaseBanner.js";
import { AppStatusBanners } from "./ConnectionDeviceSettings.js";
import { useActivityHeartbeat } from "./activityHeartbeat.js";
import { BackupWarning } from "./BackupWarning.js";
import { SensitivityToggle } from "./SensitivityToggle.js";
import { PermanentDeleteButton } from "./PermanentDelete.js";
import { CalendarWorkspace } from "./CalendarWorkspace.js";
import { parseRoute, routePath, routeTarget, type Route, type View } from "./routes.js";
import { useGuardedNavigation } from "./useGuardedNavigation.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { ApplicationShell } from "./ApplicationShell.js";
import { GlobalSearchOverlay } from "./GlobalSearchOverlay.js";
import { recordRecentSearchId } from "./globalSearch.js";
import { CapturePanel, type CaptureRequest } from "./CapturePanel.js";
import { OverlayDialog } from "./OverlayDialog.js";
import { TaskWorkspace, createStructuredEditorGuard } from "./TaskWorkspace.js";
import { OccurrenceAnchoredMarkdown, scrollVisualOccurrence } from "./occurrenceNavigation.js";
import { RecurringOccurrenceWorkspace } from "./RecurringOccurrenceWorkspace.js";
import { meetingSummary } from "./meetingSummary.js";
import { NotesWorkspace } from "./NotesWorkspace.js";
import { InboxWorkspace } from "./InboxWorkspace.js";
import { KnowledgeWorkspace } from "./KnowledgeWorkspace.js";
import { buildTrail } from "./trail.js";
import type { AppliedPatch, BackupVerification, CalendarEvent, EntityType, FocusChange, GoogleConnection, LifeObject, PersonLabel, ReviewEdits, ReviewEvidence, Workspace } from "@lifeos/contracts";

type CrepeInstance = {
  create(): Promise<unknown>;
  getMarkdown(): string;
  destroy(): Promise<unknown>;
  setReadonly(value: boolean): unknown;
  editor: { config(configure: (ctx: { set(slice: string, value: unknown): void; update(slice: string, updater: (value: never) => unknown): void }) => void): unknown };
  on(callback: (listener: { markdownUpdated(callback: (context: unknown, markdown: string, previousMarkdown: string) => void): unknown }) => void): unknown;
};
type CrepeConstructor = new (config: { root: Node; defaultValue: string; features?: Record<string, boolean>; featureConfigs?: Record<string, unknown> }) => CrepeInstance;

/** PB-027: `/` (and an unknown path) resumes the last page; the only place the page is kept outside the URL. */
const lastPathKey = "lifeos.lastPath";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function imagePreviewSource(source?: string) {
  if (!source || /^(?:https?:|data:|blob:)/i.test(source)) return source;
  const marker = source.lastIndexOf("assets/");
  if (marker === -1) return source;
  return `/api/v1/assets/${encodeURIComponent(source.slice(marker + "assets/".length))}`;
}

/** react-markdown drops unknown protocols; LifeOS object links must survive so they can be clicked (PB-007). */
const keepLifeosLinks = (url: string) => lifeosLinkId(url) ? url : defaultUrlTransform(url);

function fileContentBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}

/** The note a visual editor writes managed images against. For a calendar event with no note yet
 * (PB-020), `ensureOwner` creates it on demand — inserting an image is a real edit. */
type EditorOwner = { id: string; relativePath: string };

function VisualMarkdownEditor({ editorKey, owner, ensureOwner, markdown, readOnly, onChange, linkObjects, targetSectionId }: { linkObjects: LinkedObject[]; editorKey: string; owner: EditorOwner | undefined; ensureOwner?: () => Promise<EditorOwner | undefined>; markdown: string; readOnly: boolean; onChange: (markdown: string) => void; targetSectionId?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const crepe = useRef<CrepeInstance | undefined>(undefined);
  // Latest props for callbacks created once per mount. Reading these through refs matters: `readOnly`
  // is true while an event is being opened (busy) and the editor finishes loading asynchronously, so
  // a value captured at mount time would leave the editor — and its ribbon, which Crepe hides when
  // read-only — locked until the next remount (PB-019).
  const latest = useRef({ owner, ensureOwner, readOnly, onChange, linkObjects });
  latest.current = { owner, ensureOwner, readOnly, onChange, linkObjects };
  // Only changes made after the user has focused the editor count as edits. Crepe can re-emit
  // normalized Markdown on its own after loading; that must never dirty the draft or trigger a save.
  const engaged = useRef(false);
  // #89: whether saving from this editor would rewrite Markdown the user did not edit.
  const [roundTrip, setRoundTrip] = useState<RoundTripReport>();
  // #91: images this editor would drop if it saved. When any, the editor stays read-only and never saves.
  const [lost, setLost] = useState<string[]>();
  const blocked = useRef(false);

  useEffect(() => {
    if (!root.current) return;
    let active = true;
    let instance: CrepeInstance | undefined;
    const editorRoot = root.current;
    engaged.current = false;
    blocked.current = false;
    setRoundTrip(undefined);
    setLost(undefined);
    void Promise.all([import("@milkdown/crepe"), import("./visualEditorImages.js")]).then(async ([crepePackage, { prepareVisualEditor }]) => {
      if (!active) return;
      const Crepe = (crepePackage as unknown as { Crepe: CrepeConstructor }).Crepe;
      const uploadManagedImage = async (file: File) => {
        const target = latest.current.owner ?? await latest.current.ensureOwner?.();
        if (!target) throw new Error("Could not create the note to attach this image to");
        const stored = await api("POST /api/v1/objects/:id/assets", { params: { id: target.id }, body: { fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64: await fileContentBase64(file) } });
        return `/api/v1/assets/${encodeURIComponent(stored.relativePath.replace(/^assets\//, ""))}`;
      };
      instance = new Crepe({
        root: editorRoot,
        defaultValue: visualMarkdown(markdown),
        features: visualEditorFeatures,
        featureConfigs: { "image-block": { onUpload: uploadManagedImage, inlineOnUpload: uploadManagedImage, blockOnUpload: uploadManagedImage, proxyDomURL: imagePreviewSource } }
      });
      crepe.current = instance;
      prepareVisualEditor(instance);
      // Milkdown blanks the href of links it does not consider safe, which includes lifeos://. Keep the
      // target on a data attribute so the app's click handler can still follow it (PB-007).
      instance.editor.config((ctx) => ctx.set("linkAttr", (mark: { attrs: { href?: string } }) => (lifeosLinkId(mark.attrs.href) ? { "data-lifeos-href": mark.attrs.href } : {})));
      instance.on((listener) => listener.markdownUpdated((_context, nextMarkdown) => {
        if (!engaged.current || blocked.current) return;
        latest.current.onChange(storedMarkdown(nextMarkdown, latest.current.owner?.relativePath ?? "meetings/pending.md", markdown));
      }));
      await instance.create();
      if (!active) return;
      const unedited = storedMarkdown(instance.getMarkdown(), latest.current.owner?.relativePath ?? "meetings/pending.md", markdown);
      const missing = lostImages(markdown, unedited);
      blocked.current = missing.length > 0;
      instance.setReadonly(latest.current.readOnly || blocked.current);
      setLost(missing);
      setRoundTrip(roundTripReport(markdown, unedited));
      scrollVisualOccurrence(editorRoot, markdown, targetSectionId);
    });
    return () => { active = false; crepe.current = undefined; if (instance) void instance.destroy(); };
  }, [editorKey]);

  useEffect(() => { crepe.current?.setReadonly(readOnly || blocked.current); }, [readOnly]);
  useEffect(() => { if (root.current) scrollVisualOccurrence(root.current, markdown, targetSectionId); }, [markdown, targetSectionId]);
  return <><ImageLossNotice lost={lost} />{!lost?.length && <UnprovenFormattingLabel report={roundTrip} />}<div className="visual-markdown-editor" ref={root} onPasteCapture={(event) => { if (!latest.current.readOnly) pasteLifeosLink(event.nativeEvent, crepe.current as never, latest.current.linkObjects); }} onFocusCapture={() => { engaged.current = true; }} onPointerDownCapture={() => { engaged.current = true; }} /></>;
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
  const [selectedNoteWorkspace, setSelectedNoteWorkspace] = useState<Workspace>();
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
  const [captureOpen, setCaptureOpen] = useState(false);
  const [lastVerification, setLastVerification] = useState<BackupVerification>();
  const [googleConnection, setGoogleConnection] = useState<GoogleConnection>();
  const [displayTimeZone, setDisplayTimeZone] = useState(storedDisplayTimeZone);
  const { today, todayPanels, tasks, projects, reviews, health, backups, knowledge, clients, products, people, objectLinks, notes, deletedNotes, inboxDrafts, appliedPatches, personLabels, enrichment, connections, refresh, refreshTodayPanels, refreshConnections, refreshNotes, refreshNoteLists, refreshObjectLinks, updateNotes, updateToday, updateHealth } = useWorkspaceData({ displayTimeZone });
  const [selectedDate, setSelectedDate] = useState(() => (route?.view === "Calendar" && route.date) || dateInTimeZone(new Date(), storedDisplayTimeZone()));
  // PB-027: open items in the URL are resolved only once the lists they live in have loaded.
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const refreshGoogleConnection = () => { void api("GET /api/v1/connections/google").then(setGoogleConnection).catch(() => undefined); };
  const [message, setMessage] = useState("Loading local workspace…");
  const calendar = useCalendar({ selectedDate, displayTimeZone, onFailure: setMessage, onGoogleStatusStale: refreshGoogleConnection });
  const [editorMode, setEditorMode] = useState<"visual" | "write" | "preview">("visual");
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const notesEditor = useRef<HTMLTextAreaElement>(null);
  const notesImageInput = useRef<HTMLInputElement>(null);
  const taskEditorGuard = useRef(createStructuredEditorGuard()).current;
  const decisionEditorGuard = useRef(createStructuredEditorGuard()).current;
  const openPointEditorGuard = useRef(createStructuredEditorGuard()).current;
  const settingsEditorGuard = useRef(createSettingsEditorGuard()).current;
  const selectedNote = notes.find((note) => note.frontmatter.id === selectedNoteId);
  const selectedRecurringMeetingId = selectedNote?.frontmatter.recurrence_series_id && typeof selectedNote.frontmatter.meeting_id === "string" ? selectedNote.frontmatter.meeting_id : undefined;
  useEffect(() => {
    const meetingId = selectedRecurringMeetingId;
    if (!meetingId) { setSelectedNoteWorkspace(undefined); return; }
    let current = true;
    void api("GET /api/v1/meetings/:id/workspace", { params: { id: meetingId } }).then((next) => { if (current) setSelectedNoteWorkspace(next); }).catch(() => { if (current) setSelectedNoteWorkspace(undefined); });
    return () => { current = false; };
  }, [selectedNote?.frontmatter.id, selectedNote?.contentHash, selectedRecurringMeetingId]);
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
  const notesController = useNoteDraftController({
    note: selectedNote,
    readOnly,
    busy,
    onMessage: setMessage,
    onSaved: (updated) => updateNotes((current) => current.map((note) => note.frontmatter.id === updated.frontmatter.id ? updated as LifeObject : note).sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at))),
    fetchLatest: fetchLatestNote
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
        held.people_ids = [...new Set([...(held.people_ids as string[]), ...defaults.filter((id) => !headerOptions.people.some((option) => option.id === id))])];
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
  const guarded = useGuardedNavigation({ editors: [notesController, meetingController, taskEditorGuard, decisionEditorGuard, openPointEditorGuard, settingsEditorGuard], readOnly, onLeaveFailed: setMessage });
  const leaveEditors = guarded.leave;
  // While a held Back/Forward saves, nothing else may change the URL: a first save over a calendar
  // event would otherwise replace the URL with the new meeting's and release the held navigation.
  const settlingNavigation = guarded.settling;
  // A path whose item the app already put on screen itself (an opened event, a just-created meeting).
  const routeAlreadyShown = useRef<string | undefined>(undefined);
  const followRoute = (next: Route, options: { replace?: boolean; shown?: boolean } = {}) => {
    const path = routePath(next);
    if (path === locationRef.current.pathname) return;
    if (options.shown) routeAlreadyShown.current = path;
    guarded.follow(path, options);
  };
  const go = async (next: Route, options: { replace?: boolean } = {}) => {
    if (!(await leaveEditors())) return false;
    followRoute(next, options);
    return true;
  };
  /** The tab's own page, keeping the note or meeting it last had open. */
  const tabRoute = (target: View): Route => target === "Notes" ? { view: "Notes", noteTab: "open", id: selectedNoteId }
    : target === "Calendar" ? { view: "Calendar", date: selectedDate, id: workspace && workspace.persisted !== false ? workspace.meeting.frontmatter.id : undefined }
    : { view: target };
  const calendarRoute = (date: string): Route => ({ view: "Calendar", date, id: route?.view === "Calendar" ? route.id : undefined });

  const refreshWorkspace = async (meetingId: string) => {
    const next = await api("GET /api/v1/meetings/:id/workspace", { params: { id: meetingId } });
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
      setEditorMode("visual"); setEditorSession((session) => session + 1);
      await run(() => refreshWorkspace(meetingId), "Meeting opened");
    })();
  }, [location.pathname, collectionsLoaded]);

  // ADR 0019: a legacy recurring Meeting/Note link names the exact occurrence section.
  // Preview-mode anchors scroll natively; write mode also selects the stored anchor marker.
  useEffect(() => {
    const sectionId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!sectionId) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const anchor = document.getElementById(sectionId);
      if (anchor) { anchor.scrollIntoView({ block: "center" }); return; }
      const area = route?.view === "Calendar" ? editor.current : route?.view === "Notes" ? notesEditor.current : undefined;
      const body = route?.view === "Calendar" ? meetingController.draft : route?.view === "Notes" ? notesController.draft : "";
      const offset = body.indexOf(`<a id="${sectionId}"></a>`);
      if (area && offset >= 0) { area.focus(); area.setSelectionRange(offset, offset); area.scrollIntoView({ block: "center" }); }
    }));
  }, [location.pathname, workspace?.note?.frontmatter.id, selectedNote?.frontmatter.id, editorMode]);

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

  const createEntity = (type: EntityType, fields: Record<string, unknown>) => run(async () => {
    await api("POST /api/v1/entities/:type", { params: { type }, body: { fields } });
    await refresh();
  }, `${type} created`);

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

  function insertMarkdown(before: string, after = "", placeholder = "text") {
    const area = editor.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const draft = meetingController.draft;
    const selected = draft.slice(start, end) || placeholder;
    const next = `${draft.slice(0, start)}${before}${selected}${after}${draft.slice(end)}`;
    meetingController.setDraft(next);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  function insertAtCursor(content: string, selectFrom = 0, selectLength = 0) {
    const area = editor.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const draft = meetingController.draft;
    meetingController.setDraft(`${draft.slice(0, start)}${content}${draft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + selectFrom, start + selectFrom + selectLength); });
  }

  function transformLines(transform: (line: string, index: number) => string, placeholder = "List item") {
    const area = editor.current;
    if (!area) return;
    const selectionStart = area.selectionStart;
    const selectionEnd = area.selectionEnd;
    const draft = meetingController.draft;
    const start = draft.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const nextBreak = draft.indexOf("\n", selectionEnd);
    const end = nextBreak === -1 ? draft.length : nextBreak;
    const source = draft.slice(start, end) || placeholder;
    const replacement = source.split("\n").map(transform).join("\n");
    meetingController.setDraft(`${draft.slice(0, start)}${replacement}${draft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start, start + replacement.length); });
  }

  function applyHeading(level: string) {
    if (!level) return;
    transformLines((line) => `${"#".repeat(Number(level))} ${line.replace(/^#{1,6}\s+/, "")}`, "Heading");
  }

  function insertCodeBlock() {
    const language = window.prompt("Code language (for example: typescript, python, sql)", "typescript");
    if (language === null) return;
    const selected = editor.current ? meetingController.draft.slice(editor.current.selectionStart, editor.current.selectionEnd) : "";
    insertMarkdown(`\n\n\`\`\`${language.trim()}\n`, "\n```\n\n", selected || "code");
  }

  // The meeting note, creating it first if the event has none yet (inserting an image is a real edit).
  async function ensureMeetingNote(): Promise<EditorOwner | undefined> {
    const existing = workspaceRef.current?.note ?? createdWorkspace.current?.note;
    if (existing && !meetingController.pending) return { id: existing.frontmatter.id, relativePath: existing.relativePath };
    if (!(await meetingController.saveNow({ allowEmpty: true }))) return undefined;
    const created = createdWorkspace.current?.note;
    return created ? { id: created.frontmatter.id, relativePath: created.relativePath } : undefined;
  }

  async function uploadImage(file: File) {
    if (!workspace || !editorReady || !file.type.startsWith("image/")) return;
    const draft = meetingController.draft;
    const insertionStart = editor.current?.selectionStart ?? draft.length;
    const insertionEnd = editor.current?.selectionEnd ?? insertionStart;
    const suggestedAlt = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    const altText = window.prompt("Describe this image for accessibility", suggestedAlt);
    if (altText === null) return;
    setBusy(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
        reader.readAsDataURL(file);
      });
      const owner = await ensureMeetingNote();
      if (!owner) throw new Error("Could not create the note to attach this image to");
      const stored = await api("POST /api/v1/objects/:id/assets", { params: { id: owner.id }, body: { fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64 } });
      const markdown = `![${altText.trim()}](${stored.markdownPath})`;
      meetingController.setDraft(`${draft.slice(0, insertionStart)}${markdown}${draft.slice(insertionEnd)}`);
      requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(insertionStart + markdown.length, insertionStart + markdown.length); });
      setMessage(stored.deduplicated ? "Existing image reused; Markdown link inserted" : "Image stored locally; Markdown link inserted");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Image upload failed");
    } finally { setBusy(false); }
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
    const unsaved = controller.dirty ? "\n\nUnsaved changes in this note will be lost." : "";
    if (!window.confirm(`Delete "${note.frontmatter.title}"?\n\nIt disappears from LifeOS. The Markdown file is kept and marked as deleted.${unsaved}`)) return false;
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

  const saveSelectedNote = async () => {
    if (!selectedNote) return false;
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

  // PB-007: a `lifeos://object/<id>` link opens the object inside the app. The object list is fetched
  // fresh so a link to something created a moment ago still works, and the note being edited is saved
  // first so leaving it can never drop text. PB-027: each link opened is a history entry.
  const openLifeosLink = async (href: string) => {
    try {
      if (!(await leaveEditors())) return;
      const objects = await refreshObjectLinks();
      const target = resolveLifeosLink(href, objects);
      if (target.kind === "invalid") return;
      if (target.kind === "missing") { setMessage("That linked object no longer exists."); return; }
      if (target.kind === "unsupported") { setMessage(`Opening a ${target.type.replace("-", " ")} from a link is not supported yet.`); return; }
      if (target.kind === "note") {
        const { open, deleted } = await refreshNoteLists();
        setNoteQuery("");
        const live = open.find((note) => note.frontmatter.id === target.id);
        const gone = deleted.find((note) => note.frontmatter.id === target.id);
        if (!live && !gone) { setMessage("That linked note no longer exists."); return; }
        followRoute({ view: "Notes", noteTab: live ? "open" : "deleted", id: target.id });
      } else if (target.kind === "meeting") {
        const meeting = objects.find((object) => object.frontmatter.id === target.id);
        const date = meeting?.frontmatter.starts_at ? dateInTimeZone(new Date(String(meeting.frontmatter.starts_at)), displayTimeZone) : selectedDate;
        followRoute({ view: "Calendar", date, id: target.id });
      } else if (target.kind === "inbox") {
        followRoute({ view: "Inbox", id: target.id });
      } else {
        followRoute(referenceRouteInSettings({ view: target.view, id: target.id }));
        // The same card again (no URL change) still flashes.
        setHighlightId(target.id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the link");
    }
  };
  // The click listener is attached once; it calls whichever handler the latest render created.
  const linkHandler = useRef(openLifeosLink);
  linkHandler.current = openLifeosLink;
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest?.("a[href], a[data-lifeos-href]");
      if (!anchor) return;
      // The editor's link bubble shows the raw address as its text, with an emptied href (PB-007).
      const href = anchor.getAttribute("data-lifeos-href") ?? (anchor.closest(".milkdown-link-preview") ? anchor.textContent : anchor.getAttribute("href"));
      if (!lifeosLinkId(href)) return;
      // The browser cannot open lifeos:// itself, so it must never follow the link (an emptied href
      // would open this page again in a new tab). One click opens the object, in every mode.
      event.preventDefault();
      event.stopPropagation();
      void linkHandler.current(href!.trim());
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
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
  // attendees are shown when they match an object LifeOS already has (by name), and the rest stay
  // blank until the first edit creates them. The id and hash are fixed so the form is not re-seeded.
  const pendingHeaderNote = (current: Workspace) => {
    const match = (options: { id: string; title: string }[], object?: LifeObject) => object ? options.find((option) => foldText(option.title) === foldText(object.frontmatter.title))?.id ?? "" : "";
    return {
      contentHash: PENDING_NOTE_HASH,
      frontmatter: {
        id: current.meeting.frontmatter.id, type: "meeting-note", title: `${current.meeting.frontmatter.title} notes`,
        primary_project_id: match(headerOptions.projects, current.context.project), primary_client_id: match(headerOptions.clients, current.context.client), primary_product_id: match(headerOptions.products, current.context.product),
        people_ids: current.context.people.map((person) => match(headerOptions.people, person)).filter(Boolean)
      }
    };
  };

  function editNotes(before: string, after = "", placeholder = "text") {
    const area = notesEditor.current;
    if (!area) return;
    const start = area.selectionStart; const end = area.selectionEnd;
    const notesDraft = notesController.draft;
    const selected = notesDraft.slice(start, end) || placeholder;
    notesController.setDraft(`${notesDraft.slice(0, start)}${before}${selected}${after}${notesDraft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  function insertNotes(content: string) {
    const area = notesEditor.current;
    if (!area) return;
    const start = area.selectionStart; const end = area.selectionEnd;
    const notesDraft = notesController.draft;
    notesController.setDraft(`${notesDraft.slice(0, start)}${content}${notesDraft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + content.length, start + content.length); });
  }

  function transformNoteLines(transform: (line: string, index: number) => string, placeholder = "List item") {
    const area = notesEditor.current;
    if (!area) return;
    const selectionStart = area.selectionStart; const selectionEnd = area.selectionEnd;
    const notesDraft = notesController.draft;
    const start = notesDraft.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const nextBreak = notesDraft.indexOf("\n", selectionEnd); const end = nextBreak === -1 ? notesDraft.length : nextBreak;
    const replacement = (notesDraft.slice(start, end) || placeholder).split("\n").map(transform).join("\n");
    notesController.setDraft(`${notesDraft.slice(0, start)}${replacement}${notesDraft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start, start + replacement.length); });
  }

  async function uploadNotesImage(file: File) {
    if (!selectedNote || !file.type.startsWith("image/")) return;
    const notesDraft = notesController.draft;
    const start = notesEditor.current?.selectionStart ?? notesDraft.length;
    const end = notesEditor.current?.selectionEnd ?? start;
    const altText = window.prompt("Describe this image for accessibility", file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
    if (altText === null) return;
    setBusy(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(reader.error ?? new Error("Could not read the image")); reader.readAsDataURL(file);
      });
      const stored = await api("POST /api/v1/objects/:id/assets", { params: { id: selectedNote.frontmatter.id }, body: { fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64 } });
      const markdown = `![${altText.trim()}](${stored.markdownPath})`;
      notesController.setDraft(`${notesDraft.slice(0, start)}${markdown}${notesDraft.slice(end)}`);
      setMessage(stored.deduplicated ? "Existing image reused; Markdown link inserted" : "Image stored locally; Markdown link inserted");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Image upload failed"); }
    finally { setBusy(false); }
  }

  // "Keep browser version" / "Keep disk version" for both editors now live on their respective
  // controller (useNoteDraftController.ts) — wrapped with `busy` here since only the caller knows
  // when a click, rather than autosave, is in flight.
  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  }

  const pendingReviews = reviews.filter((review) => review.frontmatter.status === "pending");
  const renderOccurrenceProposal = (review: LifeObject) => <ReviewCard review={review} busy={busy || readOnly} onAccept={() => accept(review)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} labels={labels} linkActions={linkActionsFor(review.frontmatter.id)} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} />;
  const contentClassName = [(view === "Notes" && notesController.conflict) || (view === "Calendar" && meetingController.conflict) ? "comparing-conflict" : "", view === "Notes" || view === "Calendar" ? "fit-view" : ""].filter(Boolean).join(" ") || undefined;

  return <ApplicationShell
    activeView={view}
    pendingReviewCount={pendingReviews.length}
    status={readOnly ? (releasedAfterIdle ? "Read-only · paused after inactivity" : "Read-only · another device active") : message}
    readOnly={readOnly}
    contentClassName={contentClassName}
    onNavigate={(item) => void go(tabRoute(item))}
    onSearch={() => setSearchOpen(true)}
    onCapture={() => setCaptureOpen(true)}
  >
      <GlobalSearchOverlay open={searchOpen} tasks={tasks} notes={notes} onClose={() => setSearchOpen(false)} onOpen={(target) => void go(target)} />
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
                  ? <NoteHeader note={workspace.note} kind="CANONICAL NOTE" {...headerOptions} disabled={busy || readOnly || meetingController.autoSaving} onSave={saveMeetingNoteDetails}><div className="mode-switch"><button className={editorMode === "visual" ? "selected" : ""} onClick={() => setEditorMode("visual")}>Visual</button><button className={editorMode === "write" ? "selected" : ""} onClick={() => setEditorMode("write")}>Markdown</button><button className={editorMode === "preview" ? "selected" : ""} onClick={() => setEditorMode("preview")}>Preview</button></div><HistoryLink objectId={workspace.note.frontmatter.id} title={workspace.note.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={() => refreshWorkspace(workspace.meeting.frontmatter.id)} /></NoteHeader>
                  : <NoteHeader note={pendingHeaderNote(workspace)} kind="NEW NOTE" {...headerOptions} disabled={busy || readOnly} onSave={async (changes) => { pendingDetails.current = { ...pendingDetails.current, ...changes }; return true; }}><div className="mode-switch"><button className={editorMode === "visual" ? "selected" : ""} onClick={() => setEditorMode("visual")}>Visual</button><button className={editorMode === "write" ? "selected" : ""} onClick={() => setEditorMode("write")}>Markdown</button><button className={editorMode === "preview" ? "selected" : ""} onClick={() => setEditorMode("preview")}>Preview</button></div></NoteHeader>}
                {workspace.note && workspace.occurrences?.length ? <RecurringOccurrenceWorkspace
                  note={{ ...workspace.note, body: meetingController.draft }}
                  occurrences={workspace.occurrences}
                  selectedSectionId={decodeURIComponent(window.location.hash.replace(/^#/, "")) || workspace.occurrences.find((item) => item.meeting.frontmatter.id === workspace.meeting.frontmatter.id)?.sectionId}
                  timeZone={displayTimeZone}
                  mode="calendar"
                  currentEvent={calendar.filteredEvents.find((event) => event.meetingId === workspace.meeting.frontmatter.id || event.originalOccurrenceStartsAt === workspace.meeting.frontmatter.original_occurrence_starts_at)}
                  readOnly={busy || readOnly}
                  onBodyChange={meetingController.setDraft}
                  renderProposal={renderOccurrenceProposal}
                  onSelectSection={(section) => followRoute({ view: "Calendar", date: selectedDate, id: workspace.meeting.frontmatter.id, section }, { replace: true })}
                /> : editorMode === "write" ? <>
                  <div className="toolbar">
                    <select disabled={readOnly} aria-label="Heading level" defaultValue="" onChange={(event) => { applyHeading(event.target.value); event.target.value = ""; }}><option value="" disabled>Heading</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option><option value="4">H4</option></select>
                    <button disabled={readOnly} title="Bold" onClick={() => insertMarkdown("**", "**")}>B</button>
                    <button disabled={readOnly} title="Italic" onClick={() => insertMarkdown("*", "*")}><i>I</i></button>
                    <button disabled={readOnly} title="Inline code" onClick={() => insertMarkdown("`", "`", "code")}>{"</>"}</button>
                    <button disabled={readOnly} title="Fenced code block" onClick={insertCodeBlock}>Code block</button>
                    <button disabled={readOnly} title="Bulleted list" onClick={() => transformLines((line) => `- ${line.replace(/^[-*+]\s+/, "")}`)}>• List</button>
                    <button disabled={readOnly} title="Numbered list" onClick={() => transformLines((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`)}>1. List</button>
                    <button disabled={readOnly} title="Task checkbox" onClick={() => transformLines((line) => `- [ ] ${line.replace(/^- \[[ xX]\]\s+/, "")}`)}>☐ Task</button>
                    <button disabled={readOnly} title="Blockquote" onClick={() => transformLines((line) => `> ${line.replace(/^>\s?/, "")}`)}>❯ Quote</button>
                    <button disabled={readOnly} title="Link" onClick={() => insertMarkdown("[", "](https://)", "link text")}>Link</button>
                    <button disabled={readOnly || busy} title="Upload image" onClick={() => imageInput.current?.click()}>Image</button>
                    <input ref={imageInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} />
                    <button disabled={readOnly} title="Horizontal divider" onClick={() => insertAtCursor("\n\n---\n\n")}>―</button>
                    <button disabled={readOnly} title="Insert table" onClick={() => insertAtCursor("\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |\n\n")}>Table</button>
                    <select disabled={readOnly} aria-label="Link a LifeOS object" defaultValue="" onChange={(event) => { const object = objectLinks.find((candidate) => candidate.frontmatter.id === event.target.value); if (object) insertAtCursor(objectLinkMarkdown(object)); event.target.value = ""; }}><option value="" disabled>Link object…</option>{objectLinks.filter((object) => !object.frontmatter.deleted_at).sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title)).map((object) => <option key={object.frontmatter.id} value={object.frontmatter.id}>{object.frontmatter.type} · {object.frontmatter.title}</option>)}</select>
                  </div>
                  <textarea ref={editor} disabled={!editorReady || busy || readOnly} value={meetingController.draft} onChange={(event) => meetingController.setDraft(event.target.value)} onPaste={(event) => { const paste = markdownPasteAction(event.clipboardData, objectLinks); if (paste?.kind === "image") { event.preventDefault(); void uploadImage(paste.file); } else if (paste) { event.preventDefault(); insertAtCursor(paste.markdown); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadImage(file); } }} placeholder="Capture meeting notes… Paste or drop an image here." />
                </> : editorMode === "visual" && editorReady ? <VisualMarkdownEditor linkObjects={objectLinks} editorKey={`meeting:${editorSession}`} owner={meetingOwner} ensureOwner={ensureMeetingNote} markdown={meetingController.draft} readOnly={busy || readOnly} onChange={meetingController.setDraft} targetSectionId={decodeURIComponent(window.location.hash.replace(/^#/, "")) || undefined} /> : <div className="markdown-preview"><OccurrenceAnchoredMarkdown markdown={meetingController.draft || "_Nothing to preview yet._"} render={(chunk, key) => <ReactMarkdown key={key} remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{chunk}</ReactMarkdown>} /></div>}
                <div className="editor-footer">
                  <div className="save-state"><i className={meetingController.dirty ? "dirty" : "saved"} />{meetingController.pending && !meetingController.dirty ? "Not saved yet · nothing is written until you edit" : meetingController.dirty ? meetingController.autoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}{meetingController.undoAvailable && <button disabled={busy || readOnly} onClick={() => withBusy(meetingController.undoKeepDiskVersion)}>Undo "Keep disk version"</button>}</div>
                  <MeetingNoteActions canDelete={Boolean(workspace.note)} deleteDisabled={busy || readOnly || meetingController.autoSaving} saveDisabled={!editorReady || busy || !meetingController.dirty || readOnly} onDelete={deleteMeetingNote} onSave={saveNote} />
                </div>
                {workspace.note && <div className="metadata-strip"><Meta label="Created" value={formatDate(workspace.note.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(workspace.note.frontmatter.updated_at)} /><Meta label="Revision" value={String(workspace.note.frontmatter.revision)} /><Meta label="File" value={workspace.note.relativePath} /></div>}
              </EditorFrame>}
              {/* #45: the accepted AI summary lives in the meeting body, apart from the user's own note. */}
              {!workspace.occurrences?.length && meetingSummary(workspace.meeting.body) && <article><span>AI SUMMARY</span><h3>Summary</h3><div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{meetingSummary(workspace.meeting.body)!}</ReactMarkdown></div></article>}
              {!workspace.occurrences?.length && <article><span>REVIEW BEFORE PUBLISHING</span><h3>Meeting proposals</h3>
                {!workspace.reviews.length && <p className="muted">Process the note to create a durable review item.</p>}
                {workspace.reviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} labels={labels} linkActions={linkActionsFor(review.frontmatter.id)} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} />)}
              </article>}
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
        detailState={noteTab === "deleted" ? (selectedDeleted ? "deleted" : "empty") : selectedNote && notesController.conflict ? "conflict" : selectedNote ? "open" : "empty"}
        onQueryChange={setNoteQuery}
        onFiltersChange={setNoteFilters}
        onTabChange={(tab) => void go({ view: "Notes", noteTab: tab, id: tab === "open" ? selectedNoteId : selectedDeletedId })}
        onOpen={(id) => void go({ view: "Notes", noteTab, id })}
        onBack={() => void go({ view: "Notes", noteTab })}
        deletedDetail={!selectedDeleted ? null : <article className="editor-card">
              <div className="editor-heading"><div><span>DELETED {selectedDeleted.frontmatter.type.replace("-", " ").toUpperCase()}</span><h3>{selectedDeleted.frontmatter.title}</h3></div></div>
              <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{selectedDeleted.body || "_Empty note._"}</ReactMarkdown></div>
              <div className="editor-footer"><div className="save-state"><i className="dirty" />Deleted {formatDate(String(selectedDeleted.frontmatter.deleted_at))} · read-only</div><div className="actions"><PermanentDeleteButton key={selectedDeleted.frontmatter.id} note={selectedDeleted} disabled={busy || readOnly} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onDeleted={async (deleted) => { if (deleted) setSelectedDeletedId(undefined); await refresh(); }} /><button className="primary" disabled={busy || readOnly} onClick={() => restoreNote(selectedDeleted)}>Restore note</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedDeleted.frontmatter.created_at)} /><Meta label="Deleted" value={formatDate(String(selectedDeleted.frontmatter.deleted_at))} /><Meta label="Revision" value={String(selectedDeleted.frontmatter.revision)} /><Meta label="File" value={selectedDeleted.relativePath} /></div>
            </article>}
        conflictDetail={selectedNote && notesController.conflict ? <NoteConflictPanel noteTitle={selectedNote.frontmatter.title} draftText={notesController.draft} diskText={selectedNote.body} disabled={busy || readOnly} onKeepBrowserVersion={() => withBusy(notesController.keepBrowserVersion)} onKeepDiskVersion={() => withBusy(notesController.keepDiskVersion)} /> : null}
        renderOpenNote={(notesMode) => !selectedNote ? null : <EditorFrame>
              <NoteHeader note={selectedNote} kind={selectedNote.frontmatter.type.replace("-", " ").toUpperCase()} {...headerOptions} disabled={busy || readOnly || notesController.autoSaving} onSave={saveNotesDetails}><HistoryLink objectId={selectedNote.frontmatter.id} title={selectedNote.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={refresh} /></NoteHeader>
              {selectedNoteWorkspace?.occurrences?.length ? <RecurringOccurrenceWorkspace
                note={{ ...selectedNote, body: notesController.draft }}
                occurrences={selectedNoteWorkspace.occurrences}
                selectedSectionId={decodeURIComponent(window.location.hash.replace(/^#/, "")) || undefined}
                timeZone={displayTimeZone}
                mode="notes"
                readOnly={busy || readOnly}
                onBodyChange={notesController.setDraft}
                renderProposal={renderOccurrenceProposal}
                onSelectSection={(section) => followRoute({ view: "Notes", noteTab, id: selectedNote.frontmatter.id, section }, { replace: true })}
              /> : notesMode === "write" ? <>
                <div className="toolbar">
                  <select disabled={readOnly} aria-label="Heading level" defaultValue="" onChange={(event) => { if (event.target.value) transformNoteLines((line) => `${"#".repeat(Number(event.target.value))} ${line.replace(/^#{1,6}\s+/, "")}`, "Heading"); event.target.value = ""; }}><option value="" disabled>Heading</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option><option value="4">H4</option></select>
                  <button disabled={readOnly} title="Bold" onClick={() => editNotes("**", "**")}>B</button><button disabled={readOnly} title="Italic" onClick={() => editNotes("*", "*")}><i>I</i></button><button disabled={readOnly} title="Inline code" onClick={() => editNotes("`", "`", "code")}>{"</>"}</button>
                  <button disabled={readOnly} title="Fenced code block" onClick={() => { const language = window.prompt("Code language", "typescript"); if (language !== null) editNotes(`\n\n\`\`\`${language.trim()}\n`, "\n```\n\n", "code"); }}>Code block</button>
                  <button disabled={readOnly} title="Bulleted list" onClick={() => transformNoteLines((line) => `- ${line.replace(/^[-*+]\s+/, "")}`)}>• List</button><button disabled={readOnly} title="Numbered list" onClick={() => transformNoteLines((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`)}>1. List</button><button disabled={readOnly} title="Task checkbox" onClick={() => transformNoteLines((line) => `- [ ] ${line.replace(/^- \[[ xX]\]\s+/, "")}`)}>☐ Task</button><button disabled={readOnly} title="Blockquote" onClick={() => transformNoteLines((line) => `> ${line.replace(/^>\s?/, "")}`)}>❯ Quote</button>
                  <button disabled={readOnly} title="Link" onClick={() => editNotes("[", "](https://)", "link text")}>Link</button><button disabled={readOnly || busy} title="Upload image" onClick={() => notesImageInput.current?.click()}>Image</button><input ref={notesImageInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadNotesImage(file); event.target.value = ""; }} />
                  <button disabled={readOnly} title="Horizontal divider" onClick={() => insertNotes("\n\n---\n\n")}>―</button><button disabled={readOnly} title="Insert table" onClick={() => insertNotes("\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |\n\n")}>Table</button>
                  <select disabled={readOnly} aria-label="Link a LifeOS object" defaultValue="" onChange={(event) => { const object = objectLinks.find((candidate) => candidate.frontmatter.id === event.target.value); if (object) insertNotes(objectLinkMarkdown(object)); event.target.value = ""; }}><option value="" disabled>Link object…</option>{objectLinks.filter((object) => !object.frontmatter.deleted_at).sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title)).map((object) => <option key={object.frontmatter.id} value={object.frontmatter.id}>{object.frontmatter.type} · {object.frontmatter.title}</option>)}</select>
                </div>
                <textarea ref={notesEditor} disabled={busy || readOnly} value={notesController.draft} onChange={(event) => notesController.setDraft(event.target.value)} onPaste={(event) => { const paste = markdownPasteAction(event.clipboardData, objectLinks); if (paste?.kind === "image") { event.preventDefault(); void uploadNotesImage(paste.file); } else if (paste) { event.preventDefault(); insertNotes(paste.markdown); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} placeholder="Write Markdown… Paste or drop an image here." />
              </> : notesMode === "visual" ? <VisualMarkdownEditor linkObjects={objectLinks} editorKey={selectedNote.frontmatter.id} owner={{ id: selectedNote.frontmatter.id, relativePath: selectedNote.relativePath }} markdown={notesController.draft} readOnly={busy || readOnly} onChange={notesController.setDraft} targetSectionId={decodeURIComponent(window.location.hash.replace(/^#/, "")) || undefined} /> : <div className="markdown-preview"><OccurrenceAnchoredMarkdown markdown={notesController.draft || "_Nothing to preview yet._"} render={(chunk, key) => <ReactMarkdown key={key} remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{chunk}</ReactMarkdown>} /></div>}
              <div className="editor-footer"><div className="save-state"><i className={notesController.dirty ? "dirty" : "saved"} />{notesController.dirty ? notesController.autoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}{notesController.undoAvailable && <button disabled={busy || readOnly} onClick={() => withBusy(notesController.undoKeepDiskVersion)}>Undo "Keep disk version"</button>}</div><div className="actions"><button className="danger" disabled={busy || readOnly || notesController.autoSaving} onClick={deleteSelectedNote}>Delete note</button><button className="primary" disabled={busy || readOnly || !notesController.dirty} onClick={saveSelectedNote}>Save now</button></div></div>
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
          onOpen={(id) => void go({ view: "Inbox", id })}
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
          return { id: `reference-${plural}`, group: "Reference data", label, cards: [{ id: referenceSettingsCardId(type), label, safeNames: objects.map((object) => object.frontmatter.title), content: <ReferenceDataSettings type={type} objects={objects} linkables={objectLinks} personLabels={labels} selectedId={selection?.type === type ? selection.recordId : undefined} busy={busy} readOnly={readOnly} onOpen={(id) => followRoute({ view: "Settings", id: referenceSettingsId(type, id) })} onCreate={createReferenceEntity} onSave={updateEntity} onDelete={deleteEntity} onSetExternal={type === "person" ? setPersonExternal : undefined} onConfirmReviewed={type === "person" ? confirmPersonReviewed : undefined} run={run} onRestored={refresh} /> }] };
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
function ObjectList({ title, objects, empty }: { title: string; objects: LifeObject[]; empty: string }) {
  return <article><span>{title.toUpperCase()}</span>{!objects.length && <p className="muted">{empty}</p>}{objects.map(objectRow)}</article>;
}

// Relationship fields are not listed here: they come from `entityLinkFields` (PB-010) and use EntityLinkPicker.
const entityFields: Record<EntityType, Array<{ key: string; label: string; kind?: "select" | "date"; options?: string[] }>> = {
  task: [{ key: "status", label: "Status", kind: "select", options: ["Inbox", "Next", "Waiting", "Done", "Cancelled"] }, { key: "priority", label: "Priority", kind: "select", options: ["", "High", "Medium", "Low"] }, { key: "due_on", label: "Due date", kind: "date" }, { key: "expected_output", label: "Expected output" }],
  project: [{ key: "status", label: "Status" }, { key: "objective", label: "Objective" }, { key: "success_criteria", label: "Success criteria" }, { key: "target_end_on", label: "Target end", kind: "date" }],
  client: [{ key: "status", label: "Status" }, { key: "summary", label: "Summary" }, { key: "website_url", label: "Website" }],
  product: [{ key: "status", label: "Status" }, { key: "description", label: "Description" }],
  person: [{ key: "given_name", label: "Given name" }, { key: "family_name", label: "Family name" }, { key: "organization_name", label: "Organization" }, { key: "job_title", label: "Job title" }, { key: "timezone", label: "Timezone" }]
};

// #30: every entity can carry an agreed Area and be marked restricted. A legacy Area shows as "None"
// in the picker but is kept on save unless the user picks a new one (the server allows unchanged legacy values).
const envelopeEntityFields = [{ key: "area", label: "Area", kind: "select" as const, options: ["", ...areaOptions] }, { key: "sensitivity", label: "Sensitivity", kind: "select" as const, options: ["normal", "restricted"] }];

function EntityCrudPage({ type, title, objects: listed, linkables, labels, onSetExternal, onConfirmReviewed, busy, readOnly, embedded = false, highlightId, onCreate, onUpdate, onDelete, run, onRestored }: { run: (action: () => Promise<void>, success: string) => Promise<boolean>; onRestored: () => Promise<void>; type: EntityType; title: string; objects: LifeObject[]; linkables: Linkable[]; labels: Map<string, PersonLabel>; onSetExternal?: (object: LifeObject, choice: ExternalChoice) => void; onConfirmReviewed?: (object: LifeObject) => void; busy: boolean; readOnly: boolean; embedded?: boolean; highlightId?: string; onCreate: (type: EntityType, fields: Record<string, unknown>) => void; onUpdate: (object: LifeObject, fields: Record<string, unknown>) => void; onDelete: (object: LifeObject) => void }) {
  // #118: the tab lists live objects; a link to an archived one still opens it here.
  const objects = useMemo(() => withOpenedArchived(listed, linkables as LinkedObject[], type, highlightId) as LifeObject[], [listed, linkables, type, highlightId]);
  const [newTitle, setNewTitle] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => setDrafts(Object.fromEntries(objects.map((object) => [object.frontmatter.id, { ...object.frontmatter }]))), [objects]);
  const setField = (id: string, key: string, value: unknown) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  const create = () => { onCreate(type, { title: newTitle }); setNewTitle(""); };
  return <>{!embedded && <PageHeader eyebrow={type.toUpperCase()} title={title} description={`Create, inspect, edit, archive through history, and soft-delete ${title.toLowerCase()} stored as typed Markdown.`} />}<article className="crud-panel"><span>{embedded ? "MANAGE PROJECTS" : `MANAGE ${title.toUpperCase()}`}</span><div className="capture-row"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTitle.trim()) create(); }} placeholder={`New ${type} title`} /><button className="primary" disabled={busy || readOnly || !newTitle.trim()} onClick={create}>Create</button></div>{!objects.length && <p className="muted">No {title.toLowerCase()} yet.</p>}<div className="crud-list">{objects.map((object) => { const draft = drafts[object.frontmatter.id] ?? object.frontmatter; return <div className={object.frontmatter.id === highlightId ? "crud-card highlighted" : "crud-card"} id={`object-${object.frontmatter.id}`} key={object.frontmatter.id}><div className="crud-fields"><label><small>Title</small><input value={String(draft.title ?? "")} onChange={(event) => setField(object.frontmatter.id, "title", event.target.value)} /></label>{[...entityFields[type], ...entityLinkFields[type], ...envelopeEntityFields].map((field) => "target" in field ? <EntityLinkPicker key={field.key} field={field} value={draft[field.key]} objects={linkables} labels={labels} selfId={object.frontmatter.id} disabled={busy || readOnly} onChange={(value) => setField(object.frontmatter.id, field.key, value)} /> : <label key={field.key}><small>{field.label}</small>{field.kind === "select" ? <select value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)}>{field.options!.map((option) => <option value={option} key={option}>{option || "None"}</option>)}</select> : <input type={field.kind === "date" ? "date" : "text"} value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)} />}</label>)}</div><div className="crud-actions">{type === "person" && <PersonExternalControl person={object} labels={labels} disabled={busy || readOnly} onChange={onSetExternal} />}{type === "person" && onConfirmReviewed && <PersonReviewControl person={object} disabled={busy || readOnly} onConfirm={() => onConfirmReviewed(object)} />}<EnvelopeBadges frontmatter={object.frontmatter} />{Boolean(object.frontmatter.archived_at) && <small className="archived-tag">Archived</small>}<small>Revision {object.frontmatter.revision} · {formatDate(object.frontmatter.updated_at)}</small><button disabled={busy || readOnly} onClick={() => onUpdate(object, draft)}>Save changes</button><button className="danger" disabled={busy || readOnly || object.frontmatter.is_self === true} onClick={() => { if (window.confirm(`Soft-delete ${object.frontmatter.title}? The Markdown file will be retained.`)) onDelete(object); }}>Delete</button><CopyLink object={object} /><HistoryLink objectId={object.frontmatter.id} title={object.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={onRestored} /></div></div>; })}</div></article></>;
}

/** #39: the person's badge label, and the External choice (Auto follows the email domain). Saves on change. */
function PersonExternalControl({ person, labels, disabled, onChange }: { person: LifeObject; labels: Map<string, PersonLabel>; disabled: boolean; onChange?: (object: LifeObject, choice: ExternalChoice) => void }) {
  const label = personLabel(labels, person);
  const isSelf = person.frontmatter.is_self === true;
  const derived = labels.get(person.frontmatter.id)?.isExternal ? "external" : "internal";
  return <span className="person-external"><small>Shown as</small><b><PersonName {...label} /></b>{!isSelf && onChange && <label><small>External</small><select value={externalChoiceOf(person.frontmatter)} disabled={disabled} onChange={(event) => onChange(person, event.target.value as ExternalChoice)}>
    <option value="auto">Auto (by email domain{externalChoiceOf(person.frontmatter) === "auto" ? `: ${derived}` : ""})</option><option value="external">External</option><option value="internal">Internal</option>
  </select></label>}</span>;
}

// PB-027: one catch-all route; App reads the path itself (routes.ts). A data router is needed for
// useBlocker, which holds Back/Forward until the open note is saved.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);
createRoot(document.getElementById("root")!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>);
