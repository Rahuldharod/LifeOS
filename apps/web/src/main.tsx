import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useLocation } from "react-router";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./styles.css";
import { isConflictedDraft } from "./noteDraft.js";
import { ConflictBadge, NoteConflictPanel } from "./NoteConflictPanel.js";
import { api, ApiError, useServerConnection } from "./api.js";
import { clearCachedDraft, readCachedDraft, readCachedPendingDraft } from "./draftStorage.js";
import { enabledCalendars, noCalendarPrefs, reconcileFilter, resolveDefaultFilter, type CalendarOption, type CalendarPrefs } from "./calendarPrefs.js";
import { useNoteDraftController, type NoteDraftController } from "./useNoteDraftController.js";
import { groupByDay } from "./noteGroups.js";
import { useSplitPane } from "./splitPane.js";
import { EditorFrame } from "./EditorFrame.js";
import { NoteHeader } from "./NoteHeader.js";
import { EnvelopeBadges, LockBadge } from "./EnvelopeBadges.js";
import { areaOptions, isRestricted } from "./envelope.js";
import { foldText } from "./searchOptions.js";
import { lifeosLinkId, resolveLifeosLink } from "./lifeosLinks.js";
import { addCalendarDays, zonedMidnight } from "./zonedTime.js";
import { DecisionsPage } from "./DecisionsPage.js";
import { externalChoiceOf, externalChoiceValue, labelMap, personLabel, personOption, type ExternalChoice, type PersonLabel } from "./personLabels.js";
import { PersonName } from "./PersonName.js";
import { MeetingEnrichment } from "./MeetingEnrichment.js";
import { PersonReviewControl } from "./PersonReview.js";
import { OpenPointsPage } from "./OpenPointsPage.js";
import { HistoryLink } from "./HistoryPanel.js";
import { awaitingAdoptionLabel } from "./todayPanels.js";
import { LinkResolutionCard, type LinkCardActions } from "./LinkResolutionCard.js";
import { acceptLink, acceptToast, createLinkTarget } from "./linkResolution.js";
import { reviewInFlight } from "./reviewInFlight.js";
import { displayTimeZone as storedDisplayTimeZone, formatDate, formatTime } from "./dateFormat.js";
import { contextLinkFields, entityLinkFields } from "@lifeos/shared";
import { EntityLinkPicker, type Linkable } from "./EntityLinkPicker.js";
import { PageHeader, Summary, objectRow } from "./pageParts.js";
import { TodayPage, type DailyFocus, type EnrichmentStatus, type FocusChange, type Today, type TodayPanels } from "./TodayPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { loadConnections, type ConnectionSettings, type ConnectionsState } from "./connections.js";
import { SelfEmailWarning, type SetupWarning } from "./SelfEmailWarning.js";
import { MeetingNoteActions } from "./MeetingNoteActions.js";
import { KnowledgeSourceForm, sourcePreservedToast } from "./KnowledgeSourceForm.js";
import { lostImages, roundTripReport, storedMarkdown, visualEditorFeatures, visualMarkdown, type RoundTripReport } from "./editorMarkdown.js";
import { UnprovenFormattingLabel } from "./UnprovenFormattingLabel.js";
import { ImageLossNotice } from "./ImageLossNotice.js";
import { LeaseBanner, takeoverCaution } from "./LeaseBanner.js";
import { useActivityHeartbeat } from "./activityHeartbeat.js";
import { BackupWarning, type BackupWarningState } from "./BackupWarning.js";
import { SensitivityToggle } from "./SensitivityToggle.js";
import { PermanentDeleteButton } from "./PermanentDelete.js";
import { CalendarOfflineBanner, CalendarStillOfflineError, retryCalendarDay, type CalendarDay, type CalendarOffline } from "./CalendarOffline.js";
import { parseRoute, routePath, routeTarget, type Route, type View } from "./routes.js";
import { useGuardedNavigation } from "./useGuardedNavigation.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { buildTrail } from "./trail.js";

type CrepeInstance = {
  create(): Promise<unknown>;
  getMarkdown(): string;
  destroy(): Promise<unknown>;
  setReadonly(value: boolean): unknown;
  editor: { config(configure: (ctx: { set(slice: string, value: unknown): void; update(slice: string, updater: (value: never) => unknown): void }) => void): unknown };
  on(callback: (listener: { markdownUpdated(callback: (context: unknown, markdown: string, previousMarkdown: string) => void): unknown }) => void): unknown;
};
type CrepeConstructor = new (config: { root: Node; defaultValue: string; features?: Record<string, boolean>; featureConfigs?: Record<string, unknown> }) => CrepeInstance;

type Frontmatter = Record<string, unknown> & {
  id: string;
  title: string;
  type: string;
  status?: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
type LifeObject = { frontmatter: Frontmatter; body: string; relativePath: string; contentHash: string };
type Event = { externalId: string; calendarId?: string; calendarName?: string; calendarColor?: string; title: string; startsAt: string; endsAt: string; timezone: string; isAllDay?: boolean; attendees: string[]; projectName?: string; hasNote?: boolean; meetingId?: string; noteId?: string; stored?: true };
type Workspace = {
  /** False for the read-only preview of a calendar event with no meeting/note on disk yet (PB-020). */
  persisted?: boolean;
  meeting: LifeObject;
  note?: LifeObject;
  reviews: LifeObject[];
  tasks: LifeObject[];
  context: { project?: LifeObject; client?: LifeObject; product?: LifeObject; people: LifeObject[] };
};
type ProjectRollup = { project: LifeObject; tasks: LifeObject[]; meetings: LifeObject[]; decisions: LifeObject[]; openPoints: LifeObject[]; people: LifeObject[] };
type EntityRollup = { entity: LifeObject; related: LifeObject[] };
type SessionStatus = { currentDeviceId: string; activeDeviceId: string; startedAt: string; lastActivityAt: string; leaseExpiresAt: string; writeAllowed: boolean; warning?: string; releasedAfterIdle?: boolean };
type InboxDrafts = { awaiting: number; drafts?: number; patches?: number; failed: Array<{ path: string; reason: string }> };
type AdoptionBatch = { drafts: Array<{ outcome: "adopted" | "applied" | "review" | "duplicate" | "failed" | "skipped" }> };
type AppliedPatch = { auditEventId: string; objectId: string; title: string; type: string; appliedAt: string; before: Record<string, unknown>; after: Record<string, unknown>; appendedNote?: string; undone: boolean };
type SystemHealth = { status: "healthy" | "attention"; objectCount: number; diagnostics: string[]; session: SessionStatus; idleReleaseMinutes?: number; setupWarning?: SetupWarning; backupWarning?: BackupWarningState };
type BackupSummary = { backupId: string; createdAt: string; fileCount: number; totalBytes: number };
type BackupVerification = BackupSummary & { valid: boolean; restoredToTemporaryDirectory: boolean; diagnostics: string[] };
type GoogleConnection = { configured: boolean; connected: boolean; provider: string; missing?: string[]; reason?: "expired"; lastSuccessfulSyncAt?: string; lastError?: string };
type EntityType = "task" | "project" | "client" | "product" | "person";
type ObjectLink = Pick<LifeObject, "frontmatter" | "relativePath" | "contentHash">;
type StoredAsset = { relativePath: string; markdownPath: string; sha256: string; deduplicated: boolean; mimeType: string };
/** PB-027: `/` (and an unknown path) resumes the last page; the only place the page is kept outside the URL. */
const lastPathKey = "lifeos.lastPath";

function dateInTimeZone(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayRange(date: string, timeZone: string) {
  return { from: zonedMidnight(date, timeZone).toISOString(), to: zonedMidnight(addCalendarDays(date, 1), timeZone).toISOString() };
}

function formatEventTime(value: string, timeZone: string) {
  return new Date(value).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" });
}

function formatGap(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ""} free` : `${minutes}m free`;
}

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

function VisualMarkdownEditor({ editorKey, owner, ensureOwner, markdown, readOnly, onChange }: { editorKey: string; owner: EditorOwner | undefined; ensureOwner?: () => Promise<EditorOwner | undefined>; markdown: string; readOnly: boolean; onChange: (markdown: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const crepe = useRef<CrepeInstance | undefined>(undefined);
  // Latest props for callbacks created once per mount. Reading these through refs matters: `readOnly`
  // is true while an event is being opened (busy) and the editor finishes loading asynchronously, so
  // a value captured at mount time would leave the editor — and its ribbon, which Crepe hides when
  // read-only — locked until the next remount (PB-019).
  const latest = useRef({ owner, ensureOwner, readOnly, onChange });
  latest.current = { owner, ensureOwner, readOnly, onChange };
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
        const stored = await api<StoredAsset>(`/api/v1/objects/${target.id}/assets`, { method: "POST", body: JSON.stringify({ fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64: await fileContentBase64(file) }) });
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
    });
    return () => { active = false; crepe.current = undefined; if (instance) void instance.destroy(); };
  }, [editorKey]);

  useEffect(() => { crepe.current?.setReadonly(readOnly || blocked.current); }, [readOnly]);
  return <><ImageLossNotice lost={lost} />{!lost?.length && <UnprovenFormattingLabel report={roundTrip} />}<div className="visual-markdown-editor" ref={root} onFocusCapture={() => { engaged.current = true; }} onPointerDownCapture={() => { engaged.current = true; }} /></>;
}

type ReviewEvidence = { field: string; resolved: boolean; source_id?: string; source_ref?: string; source_title?: string; locator?: string; quote?: string };
type ReviewChoices = Record<"people" | "projects" | "clients" | "products", Array<{ id: string; title: string }>>;
type ReviewEdits = Record<string, string | null>;
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
function meetingSummary(body: string | undefined) {
  const marked = body?.match(/^<!-- lifeos:summary:start -->\s*\n##\s+Summary[^\n]*\n([\s\S]*?)^<!-- lifeos:summary:end -->/m);
  const match = marked ?? body?.match(/^##\s+Summary\s*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m);
  return match?.[1]?.trim() || undefined;
}

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
  const route = parseRoute(location.pathname);
  const view: View = route?.view ?? "Today";
  const [events, setEvents] = useState<Event[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [today, setToday] = useState<Today>({ tasks: [], overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 0 });
  const [todayPanels, setTodayPanels] = useState<TodayPanels>();
  const [tasks, setTasks] = useState<LifeObject[]>([]);
  const [projects, setProjects] = useState<ProjectRollup[]>([]);
  const [clients, setClients] = useState<EntityRollup[]>([]);
  const [products, setProducts] = useState<EntityRollup[]>([]);
  const [people, setPeople] = useState<EntityRollup[]>([]);
  // #39: short, unambiguous names; recomputed by the server on every load.
  const [personLabels, setPersonLabels] = useState<PersonLabel[]>([]);
  const [reviews, setReviews] = useState<Array<LifeObject & { evidence?: Record<string, ReviewEvidence[]> }>>([]);
  const [knowledge, setKnowledge] = useState<LifeObject[]>([]);
  const [notes, setNotes] = useState<LifeObject[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  // PB-025: Open/Deleted tabs and keyword search over the notes list.
  const [deletedNotes, setDeletedNotes] = useState<LifeObject[]>([]);
  const noteTab: "open" | "deleted" = route?.view === "Notes" && route.noteTab === "deleted" ? "deleted" : "open";
  const [noteQuery, setNoteQuery] = useState("");
  const [noteResults, setNoteResults] = useState<LifeObject[]>();
  const [selectedDeletedId, setSelectedDeletedId] = useState<string>();
  const [highlightId, setHighlightId] = useState<string>();
  const [notesMode, setNotesMode] = useState<"visual" | "write" | "preview">("visual");
  const [capture, setCapture] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [health, setHealth] = useState<SystemHealth>();
  const [inboxDrafts, setInboxDrafts] = useState<InboxDrafts>({ awaiting: 0, failed: [] });
  const [enrichment, setEnrichment] = useState<EnrichmentStatus>({ proposedGaveUp: [], staleWorkOrders: [] });
  const [appliedPatches, setAppliedPatches] = useState<AppliedPatch[]>([]);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [lastVerification, setLastVerification] = useState<BackupVerification>();
  const [googleConnection, setGoogleConnection] = useState<GoogleConnection>();
  // PB-022a: a failed load or sync is shown in the timeline instead of an "empty day".
  const [calendarError, setCalendarError] = useState<string>();
  // #88: the calendar could not be read; the timeline lists the meetings already in LifeOS under a banner.
  const [calendarOffline, setCalendarOffline] = useState<CalendarOffline>();
  const [connections, setConnections] = useState<ConnectionsState>();
  const [objectLinks, setObjectLinks] = useState<ObjectLink[]>([]);
  const [displayTimeZone, setDisplayTimeZone] = useState(storedDisplayTimeZone);
  const [selectedDate, setSelectedDate] = useState(() => (route?.view === "Calendar" && route.date) || dateInTimeZone(new Date(), storedDisplayTimeZone()));
  // PB-027: open items in the URL are resolved only once the lists they live in have loaded.
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [calendarFilter, setCalendarFilter] = useState("all");
  const [calendarSources, setCalendarSources] = useState<Record<string, { name: string; color?: string }>>({});
  // Every calendar the account can view; empty until loaded, or when the calendar connection is unavailable.
  const [calendarCatalog, setCalendarCatalog] = useState<CalendarOption[]>([]);
  const [calendarCatalogLoaded, setCalendarCatalogLoaded] = useState(false);
  const [calendarPrefs, setCalendarPrefs] = useState<CalendarPrefs>(noCalendarPrefs);
  const defaultFilterApplied = useRef(false);
  const [editorMode, setEditorMode] = useState<"visual" | "write" | "preview">("visual");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading local workspace…");
  const editor = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const notesEditor = useRef<HTMLTextAreaElement>(null);
  const notesImageInput = useRef<HTMLInputElement>(null);
  const selectedNote = notes.find((note) => note.frontmatter.id === selectedNoteId);
  // Which notes show a "Conflict" badge in the list — any note with a cached browser draft whose
  // base hash no longer matches the file on disk, whether or not it's the one currently open.
  const conflictedNoteIds = new Set(notes.filter((note) => isConflictedDraft(readCachedDraft(note), note)).map((note) => note.frontmatter.id));
  const readOnly = health?.session.writeAllowed === false;
  const releasedAfterIdle = readOnly && health?.session.releasedAfterIdle === true;
  // ADR 0015: real input in this tab keeps (or, when free, claims) the write lease; the answer refreshes read-only state.
  useActivityHeartbeat(async () => {
    const session = await api<SessionStatus>("/api/v1/session/activity", { method: "POST" });
    setHealth((current) => current ? { ...current, session } : current);
  });

  // Shared by notesController's `fetchLatest` option and the tab-refocus listener below: a "soft"
  // refetch that only updates the notes list state, letting useNoteDraftController's own reconcile
  // effect (watching note?.contentHash) decide whether to resync silently or flag a conflict.
  // Deliberately does NOT call notesController.open() — that would hard-reset the draft and skip
  // conflict detection entirely.
  const fetchLatestNote = useCallback(async () => {
    const refreshed = await api<LifeObject[]>("/api/v1/notes");
    setNotes(refreshed);
    return refreshed.find((candidate) => candidate.frontmatter.id === selectedNoteId);
  }, [selectedNoteId]);

  // Same "soft" refetch shape as fetchLatestNote, for the Calendar meeting workspace. No-ops when
  // no workspace is open. Deliberately does NOT call meetingController.open() for the same reason.
  const fetchLatestWorkspace = useCallback(async () => {
    if (!workspace || workspace.persisted === false) return undefined;
    const next = await api<Workspace>(`/api/v1/meetings/${workspace.meeting.frontmatter.id}/workspace`);
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
  const notesSplit = useSplitPane("lifeos.split.notes");
  const calendarSplit = useSplitPane("lifeos.split.calendar");
  const notesController = useNoteDraftController({
    note: selectedNote,
    readOnly,
    busy,
    onMessage: setMessage,
    onSaved: (updated) => setNotes((current) => current.map((note) => note.frontmatter.id === updated.frontmatter.id ? updated as LifeObject : note).sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at))),
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
      let next = await api<Workspace>("/api/v1/meetings/from-event", { method: "POST", body: JSON.stringify({ externalId: target.externalId, calendarId: target.calendarId, ...range, body }) });
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
          await api(`/api/v1/notes/${next.note.frontmatter.id}`, { method: "PATCH", body: JSON.stringify({ changes: held, expectedHash: next.note.contentHash }) });
          next = await api<Workspace>(`/api/v1/meetings/${next.meeting.frontmatter.id}/workspace`);
          pendingDetails.current = {};
        } catch (error) { setMessage(`Note created, but your title and links could not be applied: ${error instanceof Error ? error.message : "unknown error"}`); }
      }
      setWorkspace((current) => current && !current.note && (current.meeting.frontmatter.id === `preview:${target.externalId}` || current.meeting.frontmatter.id === next.meeting.frontmatter.id) ? next : current);
      if (previewTarget.current === target) previewTarget.current = undefined;
      // PB-027: the new meeting gets its own URL, replacing the event's, while the user is still on it.
      const here = parseRoute(locationRef.current.pathname);
      if (here?.view === "Calendar" && !here.id && !settlingNavigation.current) followRoute({ view: "Calendar", date: target.date, id: next.meeting.frontmatter.id }, { replace: true, shown: true });
      setEvents((current) => current.map((event) => event.externalId === target.externalId && event.calendarId === target.calendarId
        ? { ...event, hasNote: Boolean(next.note), meetingId: next.meeting.frontmatter.id, noteId: next.note?.frontmatter.id }
        : event));
      createdWorkspace.current = next;
      void loadCollections();
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
  const guarded = useGuardedNavigation({ editors: [notesController, meetingController], readOnly, onLeaveFailed: setMessage });
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

  const loadCollections = async () => {
    // Without labels, badges fall back to full titles rather than failing the whole load.
    const labelsRequest = api<PersonLabel[]>("/api/v1/people/labels").catch(() => [] as PersonLabel[]);
    const [nextToday, nextTasks, nextProjects, nextReviews, nextHealth, nextBackups, nextKnowledge, nextClients, nextProducts, nextPeople, nextObjectLinks, nextNotes, nextDeletedNotes, nextInboxDrafts] = await Promise.all([
      api<Today>(`/api/v1/today?date=${dateInTimeZone(new Date(), displayTimeZone)}`), api<LifeObject[]>("/api/v1/tasks"),
      api<ProjectRollup[]>("/api/v1/projects"), api<Array<LifeObject & { evidence?: Record<string, ReviewEvidence[]> }>>("/api/v1/review-items"), api<SystemHealth>("/api/v1/health"), api<BackupSummary[]>("/api/v1/backups"), api<LifeObject[]>("/api/v1/knowledge"), api<EntityRollup[]>("/api/v1/rollups/client"), api<EntityRollup[]>("/api/v1/rollups/product"), api<EntityRollup[]>("/api/v1/rollups/person"), api<ObjectLink[]>("/api/v1/objects"), api<LifeObject[]>("/api/v1/notes"), api<LifeObject[]>("/api/v1/notes?state=deleted"), api<InboxDrafts>("/api/v1/inbox/drafts")
    ]);
    setToday(nextToday); setTasks(nextTasks); setProjects(nextProjects); setReviews(nextReviews); setHealth(nextHealth); setBackups(nextBackups); setKnowledge(nextKnowledge); setClients(nextClients); setProducts(nextProducts); setPeople(nextPeople); setObjectLinks(nextObjectLinks); setNotes(nextNotes); setDeletedNotes(nextDeletedNotes); setInboxDrafts(nextInboxDrafts);
    setAppliedPatches(await api<AppliedPatch[]>("/api/v1/inbox/patches"));
    // #77: loaded on its own; a Keychain problem only shows on the Connections card, never fails a load or a save.
    void loadConnections(() => api<ConnectionSettings>("/api/v1/settings/connections"), connections?.settings).then(setConnections);
    // #44: loaded on its own so a failure here never blanks the other panels.
    void api<EnrichmentStatus>("/api/v1/enrichment").then(setEnrichment).catch(() => undefined);
    // #48: likewise; it may wait on the calendar, so it never holds up the rest of the page.
    void loadTodayPanels();
    setPersonLabels(await labelsRequest);
  };

  const loadTodayPanels = () => api<TodayPanels>(`/api/v1/today/panels?date=${dateInTimeZone(new Date(), displayTimeZone)}&timeZone=${encodeURIComponent(displayTimeZone)}`).then(setTodayPanels).catch(() => undefined);

  const refreshWorkspace = async (meetingId: string) => {
    const next = await api<Workspace>(`/api/v1/meetings/${meetingId}/workspace`);
    setWorkspace(next);
    if (next.note) meetingController.open(next.note, readCachedDraft(next.note)); else if (!previewTarget.current) meetingController.reset();
  };

  // Preferences live in the synced data folder; the calendar list comes from Google. Either may fail independently.
  const loadCalendarCatalog = async () => {
    const [catalog, prefs] = await Promise.all([
      api<CalendarOption[]>("/api/v1/calendar/calendars").catch(() => [] as CalendarOption[]),
      api<CalendarPrefs>("/api/v1/settings/calendar-preferences").catch(() => undefined)
    ]);
    setCalendarCatalog(catalog);
    if (prefs) setCalendarPrefs(prefs);
    setCalendarCatalogLoaded(true);
  };

  /** Saves to the synced settings file; resolves to an error message, or undefined on success. */
  const saveCalendarPrefs =async (next: CalendarPrefs): Promise<string | undefined> => {
    try {
      setCalendarPrefs(await api<CalendarPrefs>("/api/v1/settings/calendar-preferences", { method: "PUT", body: JSON.stringify({ ...next, expectedHash: calendarPrefs.contentHash }) }));
      return undefined;
    } catch (error) {
      await loadCalendarCatalog();
      return error instanceof ApiError && error.status === 409 ? "These preferences were changed on another device. The latest version is loaded; make your change again." : error instanceof Error ? error.message : "Could not save calendar preferences";
    }
  };

  /** #88: an unreadable calendar answers with the meetings already in LifeOS and an offline state, not an error. */
  const showCalendarDay = (day: CalendarDay<Event>) => {
    setEvents(day.events);
    setCalendarError(undefined);
    setCalendarOffline(day.offline);
    // Google rejected the tokens: refresh status so the Reconnect banner appears.
    if (day.offline?.reason === "auth") void api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection).catch(() => undefined);
  };

  const loadCalendarDay = async (date = selectedDate) => {
    const range = dayRange(date, displayTimeZone);
    const day = await api<CalendarDay<Event>>(`/api/v1/calendar/day?${new URLSearchParams(range)}`);
    showCalendarDay(day);
    const nextEvents = day.events;
    setCalendarSources((current) => {
      const next = { ...current };
      if (!day.offline) for (const event of nextEvents) if (event.calendarId) next[event.calendarId] = { name: event.calendarName ?? event.calendarId, color: event.calendarColor };
      return next;
    });
    return day;
  };

  useEffect(() => {
    void loadCalendarCatalog();
    // PB-027: the URL replaced these; drop what older versions left behind.
    try { for (const key of ["lifeos.activeView", "lifeos.activeNoteId", "lifeos.activeMeetingId"]) localStorage.removeItem(key); } catch { /* storage unavailable */ }
    Promise.all([api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection).catch(() => undefined), loadCollections()])
      .then(() => setMessage("Local workspace ready"))
      .catch((error: Error) => setMessage(error.message))
      .finally(() => setCollectionsLoaded(true));
  }, []);

  const calendarFailed = (error: unknown) => {
    const text = error instanceof Error ? error.message : "Calendar could not be loaded";
    setEvents([]);
    setCalendarOffline(undefined);
    setCalendarError(text);
    // A 401 means Google rejected the tokens; refresh status so the Reconnect banner appears.
    if (error instanceof ApiError && error.status === 401) void api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection).catch(() => undefined);
    return text;
  };

  useEffect(() => {
    loadCalendarDay().catch((error: Error) => setMessage(calendarFailed(error)));
  }, [selectedDate, displayTimeZone]);

  // PB-027: `/` and unknown paths go to the last page this browser showed (or Today), without a history entry.
  useEffect(() => {
    let remembered: string | null = null;
    try {
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
    setSelectedNoteId(note.frontmatter.id); setNotesMode("visual");
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
      if (routeTarget(route, { ...routeData, objects }).kind !== "ok") { objects = await api<ObjectLink[]>("/api/v1/objects").catch(() => objects); setObjectLinks(objects); }
      if (routeTarget(route, { ...routeData, objects }).kind !== "ok") { close(); return; }
      previewTarget.current = undefined;
      setEditorMode("visual"); setEditorSession((session) => session + 1);
      await run(() => refreshWorkspace(meetingId), "Meeting opened");
    })();
  }, [location.pathname, collectionsLoaded]);

  // PB-027: a task, project, decision… in the URL is highlighted on its tab, as a PB-007 link does.
  // The plain list (e.g. the breadcrumb's tab crumb, PB-026) clears the highlight.
  useEffect(() => {
    if (!collectionsLoaded || !route || route.view === "Notes" || route.view === "Calendar") return;
    setHighlightId(route.id);
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
  const openEvent = async (selectedEvent: Event) => {
    if (!(await leaveEditors())) return false;
    // #88: offline, a stored meeting opens from LifeOS; the preview would need the calendar.
    if (selectedEvent.stored && selectedEvent.meetingId) { followRoute({ view: "Calendar", date: selectedDate, id: selectedEvent.meetingId }); return true; }
    return previewEvent(selectedEvent);
  };
  const previewEvent = (selectedEvent: Event) => run(async () => {
    const { externalId, calendarId } = selectedEvent;
    const range = dayRange(selectedDate, displayTimeZone);
    const next = await api<Workspace>(`/api/v1/meetings/preview?${new URLSearchParams({ externalId, ...(calendarId ? { calendarId } : {}), ...range })}`);
    setWorkspace(next); setEditorMode("visual"); setEditorSession((current) => current + 1);
    followRoute({ view: "Calendar", date: selectedDate, id: next.persisted !== false ? next.meeting.frontmatter.id : undefined }, { shown: true });
    if (next.persisted !== false) {
      setEvents((current) => current.map((event) => event.externalId === externalId && event.calendarId === calendarId
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
    await api(`/api/v1/review-items/${review.frontmatter.id}/accept`, { method: "POST" });
    leaveFinishedItem(review.frontmatter.id);
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await loadCollections();
  }, acceptToast(review.frontmatter)));

  /** #57: like `run`, but rethrows so the link card shows the server's error itself (role=alert). */
  const reviewStep = (reviewId: string, action: () => Promise<unknown>, success: string) => reviewRequests.run(reviewId, async () => {
    setBusy(true);
    try {
      await action();
      leaveFinishedItem(reviewId);
      if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
      await loadCollections();
      setMessage(success);
    } finally { setBusy(false); }
  }).then(() => undefined);
  const linkActionsFor = (reviewId: string): LinkCardActions => ({
    onLink: (linkTo) => reviewStep(reviewId, () => acceptLink(api, reviewId, linkTo), "Link saved"),
    onCreate: async (type, title) => { setBusy(true); try { return await createLinkTarget(api, type, title); } finally { setBusy(false); } },
    onReject: () => reviewStep(reviewId, () => api(`/api/v1/review-items/${reviewId}/reject`, { method: "POST" }), "Proposal rejected")
  });

  const reject = (reviewId: string) => reviewRequests.run(reviewId, () => run(async () => {
    await api(`/api/v1/review-items/${reviewId}/reject`, { method: "POST" });
    leaveFinishedItem(reviewId);
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await loadCollections();
  }, "Proposal rejected"));

  const editReview = (reviewId: string, changes: ReviewEdits) => run(async () => {
    await api(`/api/v1/review-items/${reviewId}`, { method: "PATCH", body: JSON.stringify(changes) });
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await loadCollections();
  }, "Proposal updated");

  const takeOverSession = () => run(async () => {
    await api("/api/v1/session/take-over", { method: "POST" });
    await loadCollections();
  }, "This device now holds the advisory write lease");

  const createBackup = () => run(async () => {
    const created = await api<BackupSummary>("/api/v1/backups", { method: "POST" });
    const verification = await api<BackupVerification>(`/api/v1/backups/${created.backupId}/verify`, { method: "POST" });
    setLastVerification(verification);
    await loadCollections();
  }, "Snapshot created and restoration drill passed");

  const verifyBackup = (backupId: string) => run(async () => {
    setLastVerification(await api<BackupVerification>(`/api/v1/backups/${backupId}/verify`, { method: "POST" }));
  }, "Backup restoration drill completed");

  const submitCapture = () => run(async () => {
    await api("/api/v1/capture", { method: "POST", body: JSON.stringify({ text: capture }) });
    setCapture(""); await loadCollections();
  }, "Captured as an Inbox task");

  const adoptDrafts = async () => {
    setBusy(true);
    try {
      const batch = await api<AdoptionBatch>("/api/v1/inbox/adopt", { method: "POST" });
      const count = (outcome: string) => batch.drafts.filter((draft) => draft.outcome === outcome).length;
      await loadCollections();
      setMessage(batch.drafts.length ? `Drafts: ${count("adopted")} adopted, ${count("applied")} patches applied, ${count("review")} sent to review, ${count("duplicate")} already adopted, ${count("failed")} failed, ${count("skipped")} still being written` : "No drafts awaiting adoption");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Adoption failed"); }
    finally { setBusy(false); }
  };

  // #44: "Enrich last 48h" writes a Work Order for Claude; the server's message says what happened.
  const requestEnrichment = async () => {
    setBusy(true);
    try {
      const result = await api<{ message: string }>("/api/v1/enrichment/work-orders", { method: "POST" });
      await loadCollections();
      setMessage(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Enrichment request failed"); }
    finally { setBusy(false); }
  };

  // #46: "Refresh" asks Claude to re-plan today by writing a replan Work Order; the brief itself is never edited here.
  const requestReplan = async () => {
    setBusy(true);
    try {
      const result = await api<{ message: string }>("/api/v1/focus/replan", { method: "POST", body: JSON.stringify({ date: dateInTimeZone(new Date(), displayTimeZone) }) });
      await loadCollections();
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
      const next = await api<DailyFocus>("/api/v1/focus/overrides", { method: "POST", body: JSON.stringify({ date: focus.date, ...change, expectedHash: focus.override?.contentHash }) });
      setToday((current) => ({ ...current, focus: next }));
      setMessage({ pin: "Pinned to today's Top 3", unpin: "Unpinned", replace: "Replaced in today's Top 3", dismiss: "Dismissed for today", restore: "Restored to today's Top 3", reset: "Your Top 3 changes for today were cleared" }[change.action]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await loadCollections(); setMessage("Today's Top 3 was changed on another device. The latest is loaded; make your change again."); }
      else setMessage(error instanceof Error ? error.message : "Could not change the Top 3");
    } finally { setBusy(false); }
  };

  const giveUpEnrichment = (meetingId: string) => run(async () => {
    const meeting = objectLinks.find((object) => object.frontmatter.id === meetingId);
    if (!meeting) throw new Error("Meeting not found; refresh and try again");
    await api(`/api/v1/meetings/${meetingId}/enrichment/gave-up`, { method: "POST", body: JSON.stringify({ expectedHash: meeting.contentHash }) });
    await loadCollections();
  }, "Stopped waiting for material for this meeting");

  const undoPatch = (patch: AppliedPatch) => run(async () => {
    await api(`/api/v1/inbox/patches/${patch.auditEventId}/undo`, { method: "POST" });
    await loadCollections();
  }, `Undid the change to ${patch.title}`);

  const ingestSource = () => run(async () => {
    await api("/api/v1/sources/text", { method: "POST", body: JSON.stringify({ title: sourceTitle, text: sourceText }) });
    setSourceTitle(""); setSourceText(""); await loadCollections();
  }, sourcePreservedToast);

  const connectGoogle = () => run(async () => {
    const response = await api<{ authorizationUrl: string }>("/api/v1/connections/google/start");
    window.location.assign(response.authorizationUrl);
  }, "Opening Google authorization");

  const syncGoogle = () => run(async () => {
    const range = dayRange(selectedDate, displayTimeZone);
    let day: CalendarDay<Event>;
    try { day = await api<CalendarDay<Event>>(`/api/v1/calendar/day/sync?${new URLSearchParams(range)}`, { method: "POST" }); }
    catch (error) { calendarFailed(error); throw error; }
    showCalendarDay(day);
    await loadCollections();
    if (day.offline) throw new Error(`Google Calendar could not be synchronized: ${day.offline.error}`);
  }, "Google Calendar synchronized");

  // #88: Retry on the offline banner (Today and Calendar) reads the calendar again, without a page reload.
  // #94: success only when the calendar is back; after a Keychain denial it asks the Keychain again first.
  const retryCalendar = () => run(async () => {
    try {
      await retryCalendarDay(calendarOffline, {
        reprobeKeychain: () => retryConnections(),
        loadDay: () => loadCalendarDay()
      });
    } catch (error) {
      if (!(error instanceof CalendarStillOfflineError)) calendarFailed(error);
      await loadTodayPanels().catch(() => undefined);
      throw error;
    }
    await loadTodayPanels();
  }, "Calendar reloaded");

  const createEntity = (type: EntityType, fields: Record<string, unknown>) => run(async () => {
    await api(`/api/v1/entities/${type}`, { method: "POST", body: JSON.stringify({ fields }) });
    await loadCollections();
  }, `${type} created`);

  const updateEntity = (object: LifeObject, fields: Record<string, unknown>) => run(async () => {
    await api(`/api/v1/entities/by-id/${object.frontmatter.id}`, { method: "PATCH", body: JSON.stringify({ fields, expectedHash: object.contentHash }) });
    await loadCollections();
  }, `${object.frontmatter.type} updated`);

  const setPersonExternal = (object: LifeObject, choice: ExternalChoice) => run(async () => {
    await api(`/api/v1/people/${object.frontmatter.id}/external`, { method: "PUT", body: JSON.stringify({ isExternal: externalChoiceValue(choice), expectedHash: object.contentHash }) });
    await loadCollections();
  }, choice === "auto" ? "External flag follows the email domain again" : `Marked ${choice}`);

  // #87: confirming an automatically created person clears its "unreviewed" marker (guarded by the content hash).
  const confirmPersonReviewed = (object: LifeObject) => run(async () => {
    await api(`/api/v1/people/${object.frontmatter.id}/reviewed`, { method: "POST", body: JSON.stringify({ expectedHash: object.contentHash }) });
    await loadCollections();
  }, `${object.frontmatter.title} confirmed`);

  // #87: Give up from the meeting page, guarded by the meeting's own content hash.
  const giveUpMeetingEnrichment = (meeting: LifeObject) => run(async () => {
    await api(`/api/v1/meetings/${meeting.frontmatter.id}/enrichment/gave-up`, { method: "POST", body: JSON.stringify({ expectedHash: meeting.contentHash }) });
    await Promise.all([refreshWorkspace(meeting.frontmatter.id), loadCollections()]);
  }, "Stopped waiting for material for this meeting");

  const deleteEntity = (object: LifeObject) => run(async () => {
    await api(`/api/v1/entities/by-id/${object.frontmatter.id}`, { method: "DELETE", body: JSON.stringify({ expectedHash: object.contentHash }) });
    leaveFinishedItem(object.frontmatter.id);
    await loadCollections();
  }, `${object.frontmatter.type} moved to deleted state`);

  const saveGoogleSecrets = (provider: "calendar" | "drive", clientId: string, clientSecret: string) => run(async () => {
    await api(`/api/v1/settings/connections/google/${provider}`, { method: "POST", body: JSON.stringify({ clientId, clientSecret }) });
    setConnections(await loadConnections(() => api<ConnectionSettings>("/api/v1/settings/connections"), connections?.settings));
    if (provider === "calendar") setGoogleConnection(await api<GoogleConnection>("/api/v1/connections/google"));
  }, `Google ${provider} credentials saved to Keychain`);

  /** #77: after a denied Keychain prompt; reads the secrets again, so macOS may ask once more. */
  const retryConnections = async () => {
    setConnections(await loadConnections(() => api<ConnectionSettings>("/api/v1/settings/connections/retry", { method: "POST" }), connections?.settings));
    void api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection).catch(() => undefined);
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
      const stored = await api<StoredAsset>(`/api/v1/objects/${owner.id}/assets`, { method: "POST", body: JSON.stringify({ fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64 }) });
      const markdown = `![${altText.trim()}](${stored.markdownPath})`;
      meetingController.setDraft(`${draft.slice(0, insertionStart)}${markdown}${draft.slice(insertionEnd)}`);
      requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(insertionStart + markdown.length, insertionStart + markdown.length); });
      setMessage(stored.deduplicated ? "Existing image reused; Markdown link inserted" : "Image stored locally; Markdown link inserted");
      await loadCollections();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Image upload failed");
    } finally { setBusy(false); }
  }


  // Debounced server-side search over the active tab. A blank query shows the full tab from state.
  // `ignore` drops a response that arrives after the query or tab already changed.
  useEffect(() => {
    const query = noteQuery.trim();
    if (!query) { setNoteResults(undefined); return; }
    let ignore = false;
    const timer = window.setTimeout(() => {
      api<LifeObject[]>(`/api/v1/notes?${new URLSearchParams({ state: noteTab, q: query })}`)
        .then((results) => { if (!ignore) setNoteResults(results); })
        .catch((error: Error) => { if (!ignore) { setNoteResults([]); setMessage(error.message); } });
    }, 200);
    return () => { ignore = true; window.clearTimeout(timer); };
  }, [noteQuery, noteTab, notes.length, deletedNotes.length]);

  const tabNotes = noteTab === "open" ? notes : deletedNotes;
  const visibleNotes = noteQuery.trim() ? (noteResults ?? []) : tabNotes;
  const selectedDeleted = deletedNotes.find((note) => note.frontmatter.id === selectedDeletedId);

  const restoreNote = (note: LifeObject) => run(async () => {
    const restored = await api<LifeObject>(`/api/v1/notes/${note.frontmatter.id}/restore`, { method: "POST", body: JSON.stringify({ expectedHash: note.contentHash }) });
    await loadCollections();
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
      await api(`/api/v1/notes/${note.frontmatter.id}`, { method: "DELETE", body: JSON.stringify({ expectedHash: note.contentHash }) });
      clearCachedDraft(note.frontmatter.id);
      controller.reset();
      afterDelete();
      await loadCollections();
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
    setEvents((current) => current.map((event) => event.noteId === noteId ? { ...event, hasNote: false, noteId: undefined } : event));
  });

  const saveSelectedNote = async () => {
    if (!selectedNote) return false;
    setBusy(true);
    try {
      if (!(await notesController.saveNow())) return false;
      await loadCollections();
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
      const objects = await api<ObjectLink[]>("/api/v1/objects");
      setObjectLinks(objects);
      const target = resolveLifeosLink(href, objects);
      if (target.kind === "invalid") return;
      if (target.kind === "missing") { setMessage("That linked object no longer exists."); return; }
      if (target.kind === "unsupported") { setMessage(`Opening a ${target.type.replace("-", " ")} from a link is not supported yet.`); return; }
      if (target.kind === "note") {
        const [open, deleted] = await Promise.all([api<LifeObject[]>("/api/v1/notes"), api<LifeObject[]>("/api/v1/notes?state=deleted")]);
        setNotes(open); setDeletedNotes(deleted); setNoteQuery("");
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
        followRoute({ view: target.view, id: target.id });
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
    if (!(await go({ view: "Settings" }))) return;
    window.setTimeout(() => { const card = document.getElementById(cardId); card?.scrollIntoView({ block: "center", behavior: "smooth" }); card?.focus({ preventScroll: true }); }, 80);
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
      await api(`/api/v1/notes/${latest.frontmatter.id}`, { method: "PATCH", body: JSON.stringify({ changes, expectedHash: latest.contentHash }) });
      await fetchLatest();
      await loadCollections();
    }, "Note details saved");
  };
  const saveNotesDetails = (changes: Record<string, unknown>) => saveDetails(notesController, fetchLatestNote, changes);
  const saveMeetingNoteDetails = (changes: Record<string, unknown>) => saveDetails(meetingController, fetchLatestWorkspace, changes);
  const optionsOf = (objects: LifeObject[]) => objects.map((object) => ({ id: object.frontmatter.id, title: object.frontmatter.title }));
  const labels = labelMap(personLabels);
  const headerOptions = { projects: optionsOf(projects.map(({ project }) => project)), clients: optionsOf(clients.map(({ entity }) => entity)), products: optionsOf(products.map(({ entity }) => entity)), people: people.map(({ entity }) => personOption(labels, entity)) };

  // The header of a note that does not exist yet: the event's own project, client, product and
  // attendees are shown when they match an object LifeOS already has (by name), and the rest stay
  // blank until the first edit creates them. The id and hash are fixed so the form is not re-seeded.
  const pendingHeaderNote = (current: Workspace) => {
    const match = (options: { id: string; title: string }[], object?: LifeObject) => object ? options.find((option) => foldText(option.title) === foldText(object.frontmatter.title))?.id ?? "" : "";
    return {
      contentHash: "pending",
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
      const stored = await api<StoredAsset>(`/api/v1/objects/${selectedNote.frontmatter.id}/assets`, { method: "POST", body: JSON.stringify({ fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64 }) });
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

  // Open on the default calendar once the list is known; afterwards only drop a selection that is no longer offered.
  useEffect(() => {
    if (!calendarCatalogLoaded) return;
    if (!defaultFilterApplied.current) {
      defaultFilterApplied.current = true;
      setCalendarFilter(resolveDefaultFilter(offeredCalendars, calendarPrefs));
    } else setCalendarFilter((current) => reconcileFilter(current, offeredCalendars));
  }, [calendarCatalogLoaded, calendarCatalog, calendarPrefs]);

  const navigation: View[] = ["Today", "Calendar", "Notes", "Tasks", "Decisions", "Open Points", "Projects", "Clients", "Products", "People", "Knowledge", "Inbox", "System"];
  const pendingReviews = reviews.filter((review) => review.frontmatter.status === "pending");
  const offeredCalendars: CalendarOption[] = calendarCatalog.length
    ? enabledCalendars(calendarCatalog, calendarPrefs)
    : Object.entries(calendarSources).map(([id, source]) => ({ id, name: source.name, color: source.color })).filter((calendar) => !calendarPrefs.disabledCalendarIds.includes(calendar.id));
  const filteredEvents = events
    .filter((event) => !event.calendarId || !calendarPrefs.disabledCalendarIds.includes(event.calendarId))
    .filter((event) => calendarFilter === "all" || event.calendarId === calendarFilter)
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const allDayEvents = filteredEvents.filter((event) => event.isAllDay);
  const timedEvents = filteredEvents.filter((event) => !event.isAllDay);

  return <main>
    <aside>
      <h1>LifeOS</h1>
      <nav className="nav-main">
        {navigation.map((item) => <button className={item === view ? "active" : ""} key={item} onClick={() => void go(tabRoute(item))}>{item}{item === "Inbox" && pendingReviews.length > 0 ? <em>{pendingReviews.length}</em> : null}</button>)}
      </nav>
      <div className="nav-footer">
        <div className="nav-actions">
          <button className={`settings-link ${view === "Settings" ? "active" : ""}`} onClick={() => void go({ view: "Settings" })}>Settings</button>
        </div>
        <p className="connection"><i className={readOnly ? "warning-dot" : ""} /> {readOnly ? (releasedAfterIdle ? "Read-only · paused after inactivity" : "Read-only · another device active") : message}</p>
      </div>
    </aside>

    <section className={[(view === "Notes" && notesController.conflict) || (view === "Calendar" && meetingController.conflict) ? "comparing-conflict" : "", view === "Notes" || view === "Calendar" ? "fit-view" : ""].filter(Boolean).join(" ") || undefined}>
      <Breadcrumbs trail={trail} onGo={(next) => void go(next)} />
      {!server.online && <article className="lease-warning" role="status"><span>LIFEOS SERVER</span><h3>Reconnecting…</h3><p>LifeOS is restarting or not running. Keep typing: your draft is kept in the browser and saves when the server is back.</p></article>}
      <LeaseBanner session={health?.session} idleMinutes={health?.idleReleaseMinutes} busy={busy} onTakeBack={takeOverSession} />
      {missingItem && <article className="lease-warning" role="status"><span>NOT FOUND</span><p>{missingItem} Showing the {view === "Calendar" ? "day" : "list"} instead.</p></article>}
      {view === "Today" && <TodayPage today={today} panels={todayPanels} enrichment={enrichment} eventCount={events.length} capture={capture} busy={busy} readOnly={readOnly} onCaptureChange={setCapture} onCapture={submitCapture} onReplan={requestReplan} onChangeFocus={changeFocus} onEnrich={requestEnrichment} onGiveUp={giveUpEnrichment} onOpenInbox={() => void go({ view: "Inbox" })} onOpenSettingsCard={openSettingsCard} timeZone={displayTimeZone} onRetryCalendar={() => void retryCalendar()} onBackUpNow={createBackup} />}

      {view === "Calendar" && <>
        <PageHeader eyebrow="CALENDAR / MEETING" title="Meeting workspace" description="Capture in Markdown, review proposed commitments, and publish only what you confirm." />
        {googleConnection?.reason === "expired" && <article className="lease-warning" role="alert"><span>GOOGLE CALENDAR</span><h3>Reconnect Google Calendar</h3><p>Google no longer accepts the saved access, so events cannot sync. {googleConnection.lastSuccessfulSyncAt ? `Last successful sync: ${new Date(googleConnection.lastSuccessfulSyncAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone })}.` : "No successful sync recorded yet."}</p><button className="takeover" disabled={busy} onClick={connectGoogle}>Reconnect</button></article>}
        {googleConnection && !googleConnection.connected && googleConnection.reason !== "expired" && <article className="lease-warning"><span>GOOGLE CALENDAR</span><h3>{googleConnection.configured ? "Ready to connect" : "Configuration required"}</h3><p>{googleConnection.configured ? "Authorize read-only access to replace the mock calendar with your upcoming events." : "Add the Google Calendar OAuth client under Settings, then return here to connect."}</p>{googleConnection.configured ? <button className="takeover" disabled={busy} onClick={connectGoogle}>Connect Google Calendar</button> : <button onClick={() => void go({ view: "Settings" })}>Open Settings</button>}</article>}
        {googleConnection?.connected && <article className="connection-card"><span>GOOGLE CALENDAR CONNECTED</span><p className="muted">Read-only access is active. Each manual sync records a durable Sync Run.</p><button disabled={busy || readOnly} onClick={syncGoogle}>Sync now</button></article>}
        <div className="meeting-layout split-layout" style={calendarSplit.style}>
          <article className="event-list">
            <div className="event-list-heading"><span>DAY TIMELINE</span><button onClick={() => void go(calendarRoute(dateInTimeZone(new Date(), displayTimeZone)))}>Today</button></div>
            <div className="calendar-controls">
              <label><small>Date</small><input type="date" value={selectedDate} onChange={(event) => { if (event.target.value) void go(calendarRoute(event.target.value)); }} /></label>
              <label><small>Calendar</small><select value={calendarFilter} onChange={(event) => setCalendarFilter(event.target.value)}>
                <option value="all">All calendars</option>
                {[...offeredCalendars].sort((left, right) => left.name.localeCompare(right.name)).map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}
              </select></label>
            </div>
            <h3 className="timeline-date">{new Date(`${selectedDate}T12:00:00.000Z`).toLocaleDateString([], { dateStyle: "full", timeZone: displayTimeZone })}</h3>
            <CalendarOfflineBanner offline={calendarOffline} timeZone={displayTimeZone} busy={busy} onRetry={() => void retryCalendar()} />
            {calendarError
              ? <div className="timeline-empty timeline-error" role="alert"><b>Calendar could not be loaded</b><small>{calendarError}</small></div>
              : !filteredEvents.length && !calendarOffline && <div className="timeline-empty"><b>No events</b><small>This calendar is clear for the selected day.</small></div>}
            <div className="timeline">
              {allDayEvents.map((event) => <div className="timeline-row" key={`${event.calendarId ?? "calendar"}:${event.externalId}`}>
                <span className="timeline-time">All day</span><span className="timeline-rail"><i style={{ background: event.calendarColor ?? "#5f8b7c" }} /></span>
                <button className={`event${event.hasNote ? " has-note" : ""}`} disabled={busy} onClick={() => openEvent(event)}>
                  <span className="event-title"><b>{event.title}</b>{event.hasNote && <span className="note-badge">✓ Note created</span>}</span>
                  <small>{event.calendarName ?? "Calendar"}</small>
                </button>
              </div>)}
              {timedEvents.map((event, index) => {
                const previousEnd = index ? Math.max(...timedEvents.slice(0, index).map((candidate) => Date.parse(candidate.endsAt))) : undefined;
                const gap = previousEnd === undefined ? 0 : Date.parse(event.startsAt) - previousEnd;
                return <React.Fragment key={`${event.calendarId ?? "calendar"}:${event.externalId}`}>
                  {gap > 60_000 && <div className="timeline-gap"><span /><span className="gap-rail">•••</span><small>{formatGap(gap)}</small></div>}
                  <div className="timeline-row">
                    <span className="timeline-time">{formatEventTime(event.startsAt, displayTimeZone)}</span><span className="timeline-rail"><i style={{ background: event.calendarColor ?? "#5f8b7c" }} /></span>
                    <button className={`event${event.hasNote ? " has-note" : ""}`} disabled={busy} onClick={() => openEvent(event)}>
                      <span className="event-title"><b>{event.title}</b>{event.hasNote && <span className="note-badge">✓ Note created</span>}</span>
                      <small>{formatEventTime(event.startsAt, displayTimeZone)}–{formatEventTime(event.endsAt, displayTimeZone)} · {event.calendarName ?? "Calendar"}</small>
                      <small>{event.attendees.length ? `${event.attendees.length} attendee${event.attendees.length === 1 ? "" : "s"}` : "No attendees"}</small>
                    </button>
                  </div>
                </React.Fragment>;
              })}
            </div>
          </article>
          <div {...calendarSplit.dividerProps} />
          <div className="meeting-main">
            {!workspace ? <article className="empty-state"><h3>Select a meeting</h3><p>Open an event to resume its canonical note or start a new one. Nothing is saved until you edit.</p></article> : <>
              <article className="meeting-header">
                <div><span>MEETING</span><h3>{workspace.meeting.frontmatter.title}</h3>{workspace.persisted !== false && <HistoryLink objectId={workspace.meeting.frontmatter.id} title={workspace.meeting.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={() => refreshWorkspace(workspace.meeting.frontmatter.id)} />}{/* #86: the meeting itself can be restricted; a restricted note restricts it too (#63). A preview has no file yet. */}{workspace.persisted !== false && <SensitivityToggle object={workspace.meeting} noun="meeting" restrictedByNote={Boolean(workspace.note && isRestricted(workspace.note.frontmatter))} disabled={busy || readOnly} run={run} onChanged={async () => { await fetchLatestWorkspace(); }} note={workspace.note && isRestricted(workspace.note.frontmatter) && !isRestricted(workspace.meeting.frontmatter) ? "Its note is restricted, so this meeting is kept away from Agents and Work Orders too." : undefined} />}</div>
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
                {editorMode === "write" ? <>
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
                    <select disabled={readOnly} aria-label="Link a LifeOS object" defaultValue="" onChange={(event) => { const object = objectLinks.find((candidate) => candidate.frontmatter.id === event.target.value); if (object) insertAtCursor(`[${object.frontmatter.title}](lifeos://object/${object.frontmatter.id})`); event.target.value = ""; }}><option value="" disabled>Link object…</option>{objectLinks.filter((object) => !object.frontmatter.deleted_at).sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title)).map((object) => <option key={object.frontmatter.id} value={object.frontmatter.id}>{object.frontmatter.type} · {object.frontmatter.title}</option>)}</select>
                  </div>
                  <textarea ref={editor} disabled={!editorReady || busy || readOnly} value={meetingController.draft} onChange={(event) => meetingController.setDraft(event.target.value)} onPaste={(event) => { const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadImage(file); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadImage(file); } }} placeholder="Capture meeting notes… Paste or drop an image here." />
                </> : editorMode === "visual" && editorReady ? <VisualMarkdownEditor editorKey={`meeting:${editorSession}`} owner={meetingOwner} ensureOwner={ensureMeetingNote} markdown={meetingController.draft} readOnly={busy || readOnly} onChange={meetingController.setDraft} /> : <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{meetingController.draft || "_Nothing to preview yet._"}</ReactMarkdown></div>}
                <div className="editor-footer">
                  <div className="save-state"><i className={meetingController.dirty ? "dirty" : "saved"} />{meetingController.pending && !meetingController.dirty ? "Not saved yet · nothing is written until you edit" : meetingController.dirty ? meetingController.autoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}{meetingController.undoAvailable && <button disabled={busy || readOnly} onClick={() => withBusy(meetingController.undoKeepDiskVersion)}>Undo "Keep disk version"</button>}</div>
                  <MeetingNoteActions canDelete={Boolean(workspace.note)} deleteDisabled={busy || readOnly || meetingController.autoSaving} saveDisabled={!editorReady || busy || !meetingController.dirty || readOnly} onDelete={deleteMeetingNote} onSave={saveNote} />
                </div>
                {workspace.note && <div className="metadata-strip"><Meta label="Created" value={formatDate(workspace.note.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(workspace.note.frontmatter.updated_at)} /><Meta label="Revision" value={String(workspace.note.frontmatter.revision)} /><Meta label="File" value={workspace.note.relativePath} /></div>}
              </EditorFrame>}
              {/* #45: the accepted AI summary lives in the meeting body, apart from the user's own note. */}
              {meetingSummary(workspace.meeting.body) && <article><span>AI SUMMARY</span><h3>Summary</h3><div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{meetingSummary(workspace.meeting.body)!}</ReactMarkdown></div></article>}
              <article><span>REVIEW BEFORE PUBLISHING</span><h3>Meeting proposals</h3>
                {!workspace.reviews.length && <p className="muted">Process the note to create a durable review item.</p>}
                {workspace.reviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} labels={labels} linkActions={linkActionsFor(review.frontmatter.id)} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} />)}
              </article>
            </>}
          </div>
        </div>
      </>}

      {view === "Notes" && <>
        <PageHeader eyebrow="NOTES" title="Recent notes" description="Open the latest meeting and knowledge notes, edit the Markdown, and save changes back to the portable repository." />
        <div className="notes-layout split-layout" style={notesSplit.style}>
          <article className="notes-list">
            <div className="notes-list-heading"><span>LATEST NOTES</span><small>{noteQuery.trim() ? `${visibleNotes.length} of ${tabNotes.length}` : `${tabNotes.length} total`}</small></div>
            <div className="notes-tabs" role="tablist" aria-label="Notes">
              <button role="tab" aria-selected={noteTab === "open"} className={noteTab === "open" ? "selected" : ""} onClick={() => void go({ view: "Notes", noteTab: "open", id: selectedNoteId })}>Open <small>{notes.length}</small></button>
              <button role="tab" aria-selected={noteTab === "deleted"} className={noteTab === "deleted" ? "selected" : ""} onClick={() => void go({ view: "Notes", noteTab: "deleted", id: selectedDeletedId })}>Deleted <small>{deletedNotes.length}</small></button>
            </div>
            <input className="notes-search" type="search" aria-label="Search notes" placeholder={noteTab === "open" ? "Search notes…" : "Search deleted notes…"} value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} />
            {!visibleNotes.length && <p className="muted">{noteQuery.trim() ? `No ${noteTab} notes match “${noteQuery.trim()}”.` : noteTab === "open" ? "No notes have been created yet." : "No deleted notes."}</p>}
            {groupByDay(visibleNotes, (note) => noteTab === "open" ? note.frontmatter.updated_at : String(note.frontmatter.deleted_at), displayTimeZone).map((group) => <div className="note-day-group" key={group.key}><h4 className="note-day-label">{group.label}</h4>{group.items.map((note) => <button className={note.frontmatter.id === (noteTab === "open" ? selectedNoteId : selectedDeletedId) ? "note-list-item selected" : "note-list-item"} key={note.frontmatter.id} onClick={() => void go({ view: "Notes", noteTab, id: note.frontmatter.id })}>
              <b>{note.frontmatter.title}<LockBadge frontmatter={note.frontmatter} />{noteTab === "open" && conflictedNoteIds.has(note.frontmatter.id) && <ConflictBadge />}</b><small>{note.frontmatter.type === "meeting-note" ? "Meeting note" : "Knowledge note"} · {noteTab === "open" ? formatTime(note.frontmatter.updated_at) : `Deleted ${formatTime(String(note.frontmatter.deleted_at))}`}</small><span>{note.body.replace(/[#>*_`[\]-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110) || "Empty note"}</span>
            </button>)}</div>)}
          </article>
          <div {...notesSplit.dividerProps} />
          <div className="notes-main">
            {noteTab === "deleted" ? (!selectedDeleted ? <article className="empty-state"><h3>Select a deleted note</h3><p>Deleted notes are kept on disk. Choose one to read it or restore it.</p></article> : <article className="editor-card">
              <div className="editor-heading"><div><span>DELETED {selectedDeleted.frontmatter.type.replace("-", " ").toUpperCase()}</span><h3>{selectedDeleted.frontmatter.title}</h3></div></div>
              <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{selectedDeleted.body || "_Empty note._"}</ReactMarkdown></div>
              <div className="editor-footer"><div className="save-state"><i className="dirty" />Deleted {formatDate(String(selectedDeleted.frontmatter.deleted_at))} · read-only</div><div className="actions"><PermanentDeleteButton key={selectedDeleted.frontmatter.id} note={selectedDeleted} disabled={busy || readOnly} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onDeleted={async (deleted) => { if (deleted) setSelectedDeletedId(undefined); await loadCollections(); }} /><button className="primary" disabled={busy || readOnly} onClick={() => restoreNote(selectedDeleted)}>Restore note</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedDeleted.frontmatter.created_at)} /><Meta label="Deleted" value={formatDate(String(selectedDeleted.frontmatter.deleted_at))} /><Meta label="Revision" value={String(selectedDeleted.frontmatter.revision)} /><Meta label="File" value={selectedDeleted.relativePath} /></div>
            </article>) :
            selectedNote && notesController.conflict ? <NoteConflictPanel noteTitle={selectedNote.frontmatter.title} draftText={notesController.draft} diskText={selectedNote.body} disabled={busy || readOnly} onKeepBrowserVersion={() => withBusy(notesController.keepBrowserVersion)} onKeepDiskVersion={() => withBusy(notesController.keepDiskVersion)} /> :
            !selectedNote ? <article className="empty-state"><h3>Select a note</h3><p>Choose a recent note to view or edit its Markdown.</p></article> : <EditorFrame>
              <NoteHeader note={selectedNote} kind={selectedNote.frontmatter.type.replace("-", " ").toUpperCase()} {...headerOptions} disabled={busy || readOnly || notesController.autoSaving} onSave={saveNotesDetails}><div className="mode-switch"><button className={notesMode === "visual" ? "selected" : ""} onClick={() => setNotesMode("visual")}>Visual</button><button className={notesMode === "write" ? "selected" : ""} onClick={() => setNotesMode("write")}>Markdown</button><button className={notesMode === "preview" ? "selected" : ""} onClick={() => setNotesMode("preview")}>Preview</button></div><HistoryLink objectId={selectedNote.frontmatter.id} title={selectedNote.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={loadCollections} /></NoteHeader>
              {notesMode === "write" ? <>
                <div className="toolbar">
                  <select disabled={readOnly} aria-label="Heading level" defaultValue="" onChange={(event) => { if (event.target.value) transformNoteLines((line) => `${"#".repeat(Number(event.target.value))} ${line.replace(/^#{1,6}\s+/, "")}`, "Heading"); event.target.value = ""; }}><option value="" disabled>Heading</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option><option value="4">H4</option></select>
                  <button disabled={readOnly} title="Bold" onClick={() => editNotes("**", "**")}>B</button><button disabled={readOnly} title="Italic" onClick={() => editNotes("*", "*")}><i>I</i></button><button disabled={readOnly} title="Inline code" onClick={() => editNotes("`", "`", "code")}>{"</>"}</button>
                  <button disabled={readOnly} title="Fenced code block" onClick={() => { const language = window.prompt("Code language", "typescript"); if (language !== null) editNotes(`\n\n\`\`\`${language.trim()}\n`, "\n```\n\n", "code"); }}>Code block</button>
                  <button disabled={readOnly} title="Bulleted list" onClick={() => transformNoteLines((line) => `- ${line.replace(/^[-*+]\s+/, "")}`)}>• List</button><button disabled={readOnly} title="Numbered list" onClick={() => transformNoteLines((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`)}>1. List</button><button disabled={readOnly} title="Task checkbox" onClick={() => transformNoteLines((line) => `- [ ] ${line.replace(/^- \[[ xX]\]\s+/, "")}`)}>☐ Task</button><button disabled={readOnly} title="Blockquote" onClick={() => transformNoteLines((line) => `> ${line.replace(/^>\s?/, "")}`)}>❯ Quote</button>
                  <button disabled={readOnly} title="Link" onClick={() => editNotes("[", "](https://)", "link text")}>Link</button><button disabled={readOnly || busy} title="Upload image" onClick={() => notesImageInput.current?.click()}>Image</button><input ref={notesImageInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadNotesImage(file); event.target.value = ""; }} />
                  <button disabled={readOnly} title="Horizontal divider" onClick={() => insertNotes("\n\n---\n\n")}>―</button><button disabled={readOnly} title="Insert table" onClick={() => insertNotes("\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |\n\n")}>Table</button>
                  <select disabled={readOnly} aria-label="Link a LifeOS object" defaultValue="" onChange={(event) => { const object = objectLinks.find((candidate) => candidate.frontmatter.id === event.target.value); if (object) insertNotes(`[${object.frontmatter.title}](lifeos://object/${object.frontmatter.id})`); event.target.value = ""; }}><option value="" disabled>Link object…</option>{objectLinks.filter((object) => !object.frontmatter.deleted_at).sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title)).map((object) => <option key={object.frontmatter.id} value={object.frontmatter.id}>{object.frontmatter.type} · {object.frontmatter.title}</option>)}</select>
                </div>
                <textarea ref={notesEditor} disabled={busy || readOnly} value={notesController.draft} onChange={(event) => notesController.setDraft(event.target.value)} onPaste={(event) => { const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} placeholder="Write Markdown… Paste or drop an image here." />
              </> : notesMode === "visual" ? <VisualMarkdownEditor editorKey={selectedNote.frontmatter.id} owner={{ id: selectedNote.frontmatter.id, relativePath: selectedNote.relativePath }} markdown={notesController.draft} readOnly={busy || readOnly} onChange={notesController.setDraft} /> : <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{notesController.draft || "_Nothing to preview yet._"}</ReactMarkdown></div>}
              <div className="editor-footer"><div className="save-state"><i className={notesController.dirty ? "dirty" : "saved"} />{notesController.dirty ? notesController.autoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}{notesController.undoAvailable && <button disabled={busy || readOnly} onClick={() => withBusy(notesController.undoKeepDiskVersion)}>Undo "Keep disk version"</button>}</div><div className="actions"><button className="danger" disabled={busy || readOnly || notesController.autoSaving} onClick={deleteSelectedNote}>Delete note</button><button className="primary" disabled={busy || readOnly || !notesController.dirty} onClick={saveSelectedNote}>Save now</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedNote.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(selectedNote.frontmatter.updated_at)} /><Meta label="Revision" value={String(selectedNote.frontmatter.revision)} /><Meta label="File" value={selectedNote.relativePath} /></div>
            </EditorFrame>}
          </div>
        </div>
      </>}

      {view === "Tasks" && <EntityCrudPage labels={labels} highlightId={highlightId} type="task" title="Tasks" objects={tasks} linkables={objectLinks} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} run={run} onRestored={loadCollections} />}

      {view === "Projects" && <><PageHeader eyebrow="PROJECTS" title="Project roll-ups" description="Meetings and tasks are computed from stable relationships, not copied lists." />
        <EntityCrudPage labels={labels} highlightId={highlightId} embedded type="project" title="Projects" objects={projects.map(({ project }) => project)} linkables={objectLinks} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} run={run} onRestored={loadCollections} />
        <div className="project-grid">{projects.map(({ project, tasks: projectTasks, meetings, decisions, openPoints, people: projectPeople }) => <article key={project.frontmatter.id}><span>PROJECT</span><h3>{project.frontmatter.title}</h3><p className="muted">{String(project.frontmatter.objective ?? "No objective")}</p><div className="project-stats"><b>{projectTasks.length}<small>tasks</small></b><b>{openPoints.filter((point) => point.frontmatter.status === "open").length}<small>open points</small></b><b>{decisions.length}<small>decisions</small></b><b>{meetings.length}<small>meetings</small></b></div><p className="muted">People: {projectPeople.length ? <PeopleList people={projectPeople} labels={labels} /> : "None linked"}</p></article>)}</div>
        {!projects.length && <article className="empty-state"><h3>No projects yet</h3><p>Opening the mock calendar event will create its linked project context.</p></article>}
      </>}

      {view === "Decisions" && <DecisionsPage projects={projects.map(({ project }) => project)} clients={clients.map(({ entity }) => entity)} products={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} timeZone={displayTimeZone} highlightId={highlightId} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onChanged={loadCollections} formatDate={formatDate} />}
      {view === "Open Points" && <OpenPointsPage projects={projects.map(({ project }) => project)} clients={clients.map(({ entity }) => entity)} products={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} timeZone={displayTimeZone} highlightId={highlightId} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onChanged={loadCollections} formatDate={formatDate} />}

      {view === "Clients" && <EntityCrudPage labels={labels} highlightId={highlightId} type="client" title="Clients" objects={clients.map(({ entity }) => entity)} linkables={objectLinks} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} run={run} onRestored={loadCollections} />}
      {view === "Products" && <EntityCrudPage labels={labels} highlightId={highlightId} type="product" title="Products" objects={products.map(({ entity }) => entity)} linkables={objectLinks} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} run={run} onRestored={loadCollections} />}
      {view === "People" && <EntityCrudPage labels={labels} onSetExternal={setPersonExternal} onConfirmReviewed={confirmPersonReviewed} highlightId={highlightId} type="person" title="People" objects={people.map(({ entity }) => entity)} linkables={objectLinks} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} run={run} onRestored={loadCollections} />}

      {view === "Inbox" && <><PageHeader eyebrow="INBOX" title="Review proposals" description="Nothing becomes a commitment until you accept it." />
        <article className="inbox-drafts"><span>AGENT DRAFTS</span><div className="capture-row"><p>{awaitingAdoptionLabel(inboxDrafts)}</p><button className="primary" disabled={busy || readOnly} onClick={() => void adoptDrafts()}>Adopt now</button></div>
          {inboxDrafts.failed.length > 0 && <><p>Failed drafts are kept in <code>_inbox/failed/</code>. Fix and re-send them, or remove the file.</p><ul className="diagnostics">{inboxDrafts.failed.map((entry) => <li key={entry.path}>{entry.reason}</li>)}</ul></>}</article>
        {appliedPatches.length > 0 && <article className="inbox-drafts"><span>APPLIED CHANGES</span><ul className="diagnostics">{appliedPatches.slice(0, 20).map((patch) => <li key={patch.auditEventId}><div className="capture-row"><p><b>{patch.title}</b>: {[...Object.keys(patch.after).map((field) => `${field} ${String(patch.before[field] ?? "none")} → ${String(patch.after[field] ?? "none")}`), ...(patch.appendedNote ? [`note added: "${patch.appendedNote}"`] : [])].join("; ") || "no change"}</p>{patch.undone ? <em>Undone</em> : <button disabled={busy || readOnly} onClick={() => void undoPatch(patch)}>Undo</button>}</div></li>)}</ul></article>}
        {!pendingReviews.length && <article className="empty-state"><h3>Inbox clear</h3><p>No proposals require your attention.</p></article>}
        {pendingReviews.map((review) => <div key={review.frontmatter.id} id={`object-${review.frontmatter.id}`} className={review.frontmatter.id === highlightId ? "review-highlight highlighted" : "review-highlight"}><ReviewCard review={review} busy={busy || readOnly} onAccept={() => accept(review)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} labels={labels} linkActions={linkActionsFor(review.frontmatter.id)} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} /></div>)}
      </>}

      {view === "Knowledge" && <><PageHeader eyebrow="KNOWLEDGE" title="Knowledge workspace" description="Preserve pasted source text. Claude proposes Knowledge Notes from it through the LifeOS skills; you review them in Inbox." /><KnowledgeSourceForm title={sourceTitle} text={sourceText} disabled={busy || readOnly} onTitleChange={setSourceTitle} onTextChange={setSourceText} onPreserve={ingestSource} /><ObjectList title="Published Knowledge Notes" objects={knowledge} empty="No Knowledge Notes have been accepted yet." /><p className="muted">Image and attachment handling remains intentionally low priority.</p></>}

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

      {view === "Settings" && <SettingsPage displayTimeZone={displayTimeZone} onDisplayTimeZoneChange={(zone) => { localStorage.setItem("lifeos.displayTimeZone", zone); setDisplayTimeZone(zone); }} calendarCatalog={calendarCatalog} calendarCatalogLoaded={calendarCatalogLoaded} calendarPrefs={calendarPrefs} onLoadCalendars={loadCalendarCatalog} onSaveCalendarPrefs={saveCalendarPrefs} connections={connections} onRetryConnections={retryConnections} busy={busy} readOnly={readOnly} onSaveGoogleSecrets={saveGoogleSecrets} onChanged={loadCollections} />}
    </section>
  </main>;
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

function EntityCrudPage({ type, title, objects, linkables, labels, onSetExternal, onConfirmReviewed, busy, readOnly, embedded = false, highlightId, onCreate, onUpdate, onDelete, run, onRestored }: { run: (action: () => Promise<void>, success: string) => Promise<boolean>; onRestored: () => Promise<void>; type: EntityType; title: string; objects: LifeObject[]; linkables: Linkable[]; labels: Map<string, PersonLabel>; onSetExternal?: (object: LifeObject, choice: ExternalChoice) => void; onConfirmReviewed?: (object: LifeObject) => void; busy: boolean; readOnly: boolean; embedded?: boolean; highlightId?: string; onCreate: (type: EntityType, fields: Record<string, unknown>) => void; onUpdate: (object: LifeObject, fields: Record<string, unknown>) => void; onDelete: (object: LifeObject) => void }) {
  const [newTitle, setNewTitle] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => setDrafts(Object.fromEntries(objects.map((object) => [object.frontmatter.id, { ...object.frontmatter }]))), [objects]);
  const setField = (id: string, key: string, value: unknown) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  const create = () => { onCreate(type, { title: newTitle }); setNewTitle(""); };
  return <>{!embedded && <PageHeader eyebrow={type.toUpperCase()} title={title} description={`Create, inspect, edit, archive through history, and soft-delete ${title.toLowerCase()} stored as typed Markdown.`} />}<article className="crud-panel"><span>{embedded ? "MANAGE PROJECTS" : `MANAGE ${title.toUpperCase()}`}</span><div className="capture-row"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTitle.trim()) create(); }} placeholder={`New ${type} title`} /><button className="primary" disabled={busy || readOnly || !newTitle.trim()} onClick={create}>Create</button></div>{!objects.length && <p className="muted">No {title.toLowerCase()} yet.</p>}<div className="crud-list">{objects.map((object) => { const draft = drafts[object.frontmatter.id] ?? object.frontmatter; return <div className={object.frontmatter.id === highlightId ? "crud-card highlighted" : "crud-card"} id={`object-${object.frontmatter.id}`} key={object.frontmatter.id}><div className="crud-fields"><label><small>Title</small><input value={String(draft.title ?? "")} onChange={(event) => setField(object.frontmatter.id, "title", event.target.value)} /></label>{[...entityFields[type], ...entityLinkFields[type], ...envelopeEntityFields].map((field) => "target" in field ? <EntityLinkPicker key={field.key} field={field} value={draft[field.key]} objects={linkables} labels={labels} selfId={object.frontmatter.id} disabled={busy || readOnly} onChange={(value) => setField(object.frontmatter.id, field.key, value)} /> : <label key={field.key}><small>{field.label}</small>{field.kind === "select" ? <select value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)}>{field.options!.map((option) => <option value={option} key={option}>{option || "None"}</option>)}</select> : <input type={field.kind === "date" ? "date" : "text"} value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)} />}</label>)}</div><div className="crud-actions">{type === "person" && <PersonExternalControl person={object} labels={labels} disabled={busy || readOnly} onChange={onSetExternal} />}{type === "person" && onConfirmReviewed && <PersonReviewControl person={object} disabled={busy || readOnly} onConfirm={() => onConfirmReviewed(object)} />}<EnvelopeBadges frontmatter={object.frontmatter} /><small>Revision {object.frontmatter.revision} · {formatDate(object.frontmatter.updated_at)}</small><button disabled={busy || readOnly} onClick={() => onUpdate(object, draft)}>Save changes</button><button className="danger" disabled={busy || readOnly || object.frontmatter.is_self === true} onClick={() => { if (window.confirm(`Soft-delete ${object.frontmatter.title}? The Markdown file will be retained.`)) onDelete(object); }}>Delete</button><HistoryLink objectId={object.frontmatter.id} title={object.frontmatter.title} disabled={busy || readOnly} run={run} onRestored={onRestored} /></div></div>; })}</div></article></>;
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
