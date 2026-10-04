import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
import { useResizableBox } from "./resizableBox.js";
import { NoteHeader } from "./NoteHeader.js";
import { EnvelopeBadges, LockBadge } from "./EnvelopeBadges.js";
import { areaOptions } from "./envelope.js";
import { foldText } from "./searchOptions.js";
import { lifeosLinkId, resolveLifeosLink } from "./lifeosLinks.js";
import { addCalendarDays, zonedMidnight } from "./zonedTime.js";
import { DecisionsPage } from "./DecisionsPage.js";
import { externalChoiceOf, externalChoiceValue, labelMap, parseDomains, personLabel, personOption, type ExternalChoice, type PersonLabel } from "./personLabels.js";
import { PersonName } from "./PersonName.js";
import { OpenPointsPage } from "./OpenPointsPage.js";

type CrepeInstance = {
  create(): Promise<unknown>;
  destroy(): Promise<unknown>;
  setReadonly(value: boolean): unknown;
  editor: { config(configure: (ctx: { set(slice: string, value: unknown): void }) => void): unknown };
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
type Event = { externalId: string; calendarId?: string; calendarName?: string; calendarColor?: string; title: string; startsAt: string; endsAt: string; timezone: string; isAllDay?: boolean; attendees: string[]; projectName?: string; hasNote?: boolean; meetingId?: string; noteId?: string };
type Workspace = {
  /** False for the read-only preview of a calendar event with no meeting/note on disk yet (PB-020). */
  persisted?: boolean;
  meeting: LifeObject;
  note?: LifeObject;
  reviews: LifeObject[];
  tasks: LifeObject[];
  context: { project?: LifeObject; client?: LifeObject; product?: LifeObject; people: LifeObject[] };
};
type FocusItem = { id: string; state: "open" | "done" | "cancelled" | "past" | "missing"; object?: LifeObject; overdue?: boolean; whyToday?: string; ifThen?: string; ageDays?: number; context?: string; ask?: string; reason?: string };
type DailyFocus = { date: string; brief?: { id: string; title: string; path: string; generatedAt: string; body: string }; iOwe: FocusItem[]; top3: FocusItem[]; top3Source: "brief" | "rule"; waitingAndDecisions: FocusItem[]; meetingPrep: FocusItem[]; dayShape?: { meetingHours: number; freeHours: number }; deferCandidates: FocusItem[]; restrictedHidden: number };
type Today = { tasks: LifeObject[]; overdue: LifeObject[]; dueToday: LifeObject[]; upcoming: LifeObject[]; waiting: LifeObject[]; topThree: Array<{ task: LifeObject; reason: string }>; reviewCount: number; focus?: DailyFocus };
type ProjectRollup = { project: LifeObject; tasks: LifeObject[]; meetings: LifeObject[]; decisions: LifeObject[]; openPoints: LifeObject[]; people: LifeObject[] };
type EntityRollup = { entity: LifeObject; related: LifeObject[] };
type SessionStatus = { currentDeviceId: string; activeDeviceId: string; startedAt: string; lastActivityAt: string; leaseExpiresAt: string; writeAllowed: boolean; warning?: string };
type InboxDrafts = { awaiting: number; failed: Array<{ path: string; reason: string }> };
type AdoptionBatch = { drafts: Array<{ outcome: "adopted" | "applied" | "duplicate" | "failed" | "skipped" }> };
type EnrichmentStatus = { proposedGaveUp: Array<{ meetingId: string; title: string; requestedAt: string }>; staleWorkOrders: Array<{ path: string; requestedAt: string; ageDays: number }> };
type AppliedPatch = { auditEventId: string; objectId: string; title: string; type: string; appliedAt: string; before: Record<string, unknown>; after: Record<string, unknown>; appendedNote?: string; undone: boolean };
type SystemHealth = { status: "healthy" | "attention"; objectCount: number; diagnostics: string[]; session: SessionStatus };
type BackupSummary = { backupId: string; createdAt: string; fileCount: number; totalBytes: number };
type BackupVerification = BackupSummary & { valid: boolean; restoredToTemporaryDirectory: boolean; diagnostics: string[] };
type GoogleConnection = { configured: boolean; connected: boolean; provider: string; missing?: string[]; reason?: "expired"; lastSuccessfulSyncAt?: string; lastError?: string };
type ConnectionSettings = { calendar: { configured: boolean; connected: boolean }; drive: { configured: boolean; connected: boolean } };
type EntityType = "task" | "project" | "client" | "product" | "person";
type ObjectLink = Pick<LifeObject, "frontmatter" | "relativePath" | "contentHash">;
type StoredAsset = { relativePath: string; markdownPath: string; sha256: string; deduplicated: boolean; mimeType: string };
type View = "Today" | "Calendar" | "Notes" | "Tasks" | "Decisions" | "Open Points" | "Projects" | "Clients" | "Products" | "People" | "Knowledge" | "Inbox" | "System" | "Settings";

const views: View[] = ["Today", "Calendar", "Notes", "Tasks", "Decisions", "Open Points", "Projects", "Clients", "Products", "People", "Knowledge", "Inbox", "System", "Settings"];

function formatDate(value: unknown) {
  if (typeof value !== "string") return "—";
  const timeZone = localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone }); }
  catch { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
}

/** Time only, for list items whose day is already shown in a group header (PB-023). */
function formatTime(value: unknown) {
  if (typeof value !== "string") return "—";
  const timeZone = localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { return new Date(value).toLocaleTimeString([], { timeStyle: "short", timeZone }); }
  catch { return new Date(value).toLocaleTimeString([], { timeStyle: "short" }); }
}

function formatEventDate(event: Event) {
  if (!event.isAllDay) return formatDate(event.startsAt);
  const timeZone = localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const safeMidday = `${event.startsAt.slice(0, 10)}T12:00:00.000Z`;
  return `${new Date(safeMidday).toLocaleDateString([], { dateStyle: "medium", timeZone })} · All day`;
}

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

const availableTimeZones = (() => {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("timeZone") : ["Europe/Paris", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
})();

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

function visualMarkdown(markdown: string) {
  return markdown.replace(/(!\[[^\]]*\]\()(?:\.\.\/)*assets\/([^\s)>]+)(\))/g, (_match, before: string, fileName: string, after: string) => `${before}/api/v1/assets/${encodeURIComponent(decodeURIComponent(fileName))}${after}`);
}

function storedMarkdown(markdown: string, ownerRelativePath: string) {
  const depth = Math.max(0, ownerRelativePath.split("/").length - 1);
  const prefix = depth ? "../".repeat(depth) : "";
  return markdown.replace(/\/api\/v1\/assets\/([^\s)>]+)/g, (_match, encoded: string) => `${prefix}assets/${decodeURIComponent(encoded)}`);
}

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

  useEffect(() => {
    if (!root.current) return;
    let active = true;
    let instance: CrepeInstance | undefined;
    const editorRoot = root.current;
    engaged.current = false;
    void import("@milkdown/crepe").then(async (crepePackage) => {
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
        features: { "top-bar": true, latex: false, ai: false },
        featureConfigs: { "image-block": { onUpload: uploadManagedImage, inlineOnUpload: uploadManagedImage, blockOnUpload: uploadManagedImage, proxyDomURL: imagePreviewSource } }
      });
      crepe.current = instance;
      // Milkdown blanks the href of links it does not consider safe, which includes lifeos://. Keep the
      // target on a data attribute so the app's click handler can still follow it (PB-007).
      instance.editor.config((ctx) => ctx.set("linkAttr", (mark: { attrs: { href?: string } }) => (lifeosLinkId(mark.attrs.href) ? { "data-lifeos-href": mark.attrs.href } : {})));
      instance.on((listener) => listener.markdownUpdated((_context, nextMarkdown) => {
        if (!engaged.current) return;
        latest.current.onChange(storedMarkdown(nextMarkdown, latest.current.owner?.relativePath ?? "meetings/pending.md"));
      }));
      await instance.create();
      if (active) instance.setReadonly(latest.current.readOnly);
    });
    return () => { active = false; crepe.current = undefined; if (instance) void instance.destroy(); };
  }, [editorKey]);

  useEffect(() => { crepe.current?.setReadonly(readOnly); }, [readOnly]);
  return <div className="visual-markdown-editor" ref={root} onFocusCapture={() => { engaged.current = true; }} onPointerDownCapture={() => { engaged.current = true; }} />;
}

type ReviewEvidence = { field: string; resolved: boolean; source_id?: string; source_ref?: string; source_title?: string; locator?: string; quote?: string };
type ReviewChoices = Record<"people" | "projects" | "clients" | "products", Array<{ id: string; title: string }>>;
type ReviewEdits = Record<string, string | null>;
/** Which proposal fields the user may edit before accepting, per target type (#34). */
const reviewEditable: Record<string, string[]> = {
  task: ["owner_person_id", "due_on", "priority", "primary_project_id", "primary_client_id", "primary_product_id"],
  decision: ["primary_project_id", "primary_client_id", "primary_product_id"],
  "open-point": ["owner_person_id", "primary_project_id", "primary_client_id", "primary_product_id"]
};

function ReviewCard({ review, busy, onAccept, onReject, onSave, evidence, choices }: {
  review: LifeObject;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSave: (changes: ReviewEdits) => void;
  /** Evidence per proposed field; a source that cannot be found is shown as unresolved. */
  evidence?: Record<string, ReviewEvidence[]>;
  choices?: ReviewChoices;
}) {
  const proposed = (review.frontmatter.proposed_fields ?? {}) as Record<string, unknown>;
  const target = String(review.frontmatter.target_object_type ?? "task");
  const current = (key: string) => String((key.startsWith("primary_") ? review.frontmatter[key] : proposed[key]) ?? "");
  const editable = review.frontmatter.review_type === "create" ? reviewEditable[target] ?? [] : [];
  const unresolvedNames = Array.isArray(review.frontmatter.unresolved_references) ? review.frontmatter.unresolved_references as Array<{ field: string; reference: string; problem: string }> : [];
  const [title, setTitle] = useState(review.frontmatter.title);
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((key) => [key, current(key)])));
  const pending = review.frontmatter.status === "pending";
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
    <small>{target} · {String(review.frontmatter.confidence_label)} confidence · {review.frontmatter.status}{review.frontmatter.origin === "agent-extracted" ? " · agent-extracted" : ""}</small>
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
  const [view, setView] = useState<View>(() => {
    const remembered = localStorage.getItem("lifeos.activeView") as View | null;
    return remembered && views.includes(remembered) ? remembered : "Today";
  });
  const [events, setEvents] = useState<Event[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [today, setToday] = useState<Today>({ tasks: [], overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 0 });
  const [tasks, setTasks] = useState<LifeObject[]>([]);
  const [projects, setProjects] = useState<ProjectRollup[]>([]);
  const [clients, setClients] = useState<EntityRollup[]>([]);
  const [products, setProducts] = useState<EntityRollup[]>([]);
  const [people, setPeople] = useState<EntityRollup[]>([]);
  // #39: short, unambiguous names; recomputed by the server on every load.
  const [personLabels, setPersonLabels] = useState<PersonLabel[]>([]);
  const [internalDomains, setInternalDomains] = useState<{ domains: string[]; contentHash?: string }>();
  const [reviews, setReviews] = useState<Array<LifeObject & { evidence?: Record<string, ReviewEvidence[]> }>>([]);
  const [knowledge, setKnowledge] = useState<LifeObject[]>([]);
  const [notes, setNotes] = useState<LifeObject[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  // PB-025: Open/Deleted tabs and keyword search over the notes list.
  const [deletedNotes, setDeletedNotes] = useState<LifeObject[]>([]);
  const [noteTab, setNoteTab] = useState<"open" | "deleted">("open");
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
  const [connectionSettings, setConnectionSettings] = useState<ConnectionSettings>();
  const [objectLinks, setObjectLinks] = useState<ObjectLink[]>([]);
  const [displayTimeZone, setDisplayTimeZone] = useState(() => localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [selectedDate, setSelectedDate] = useState(() => dateInTimeZone(new Date(), localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
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
  const rememberedNoteId = useRef<string | undefined>(localStorage.getItem("lifeos.activeNoteId") ?? undefined);
  const selectedNote = notes.find((note) => note.frontmatter.id === selectedNoteId);
  // Which notes show a "Conflict" badge in the list — any note with a cached browser draft whose
  // base hash no longer matches the file on disk, whether or not it's the one currently open.
  const conflictedNoteIds = new Set(notes.filter((note) => isConflictedDraft(readCachedDraft(note), note)).map((note) => note.frontmatter.id));
  const readOnly = health?.session.writeAllowed === false;

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
  const notesEditorBox = useResizableBox("lifeos.notesEditorSize");
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
      localStorage.setItem("lifeos.activeMeetingId", next.meeting.frontmatter.id);
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

  const loadCollections = async () => {
    // Without labels, badges fall back to full titles rather than failing the whole load.
    const labelsRequest = api<PersonLabel[]>("/api/v1/people/labels").catch(() => [] as PersonLabel[]);
    const [nextToday, nextTasks, nextProjects, nextReviews, nextHealth, nextBackups, nextKnowledge, nextClients, nextProducts, nextPeople, nextSettings, nextObjectLinks, nextNotes, nextDeletedNotes, nextInboxDrafts] = await Promise.all([
      api<Today>(`/api/v1/today?date=${dateInTimeZone(new Date(), displayTimeZone)}`), api<LifeObject[]>("/api/v1/tasks"),
      api<ProjectRollup[]>("/api/v1/projects"), api<Array<LifeObject & { evidence?: Record<string, ReviewEvidence[]> }>>("/api/v1/review-items"), api<SystemHealth>("/api/v1/health"), api<BackupSummary[]>("/api/v1/backups"), api<LifeObject[]>("/api/v1/knowledge"), api<EntityRollup[]>("/api/v1/rollups/client"), api<EntityRollup[]>("/api/v1/rollups/product"), api<EntityRollup[]>("/api/v1/rollups/person"), api<ConnectionSettings>("/api/v1/settings/connections"), api<ObjectLink[]>("/api/v1/objects"), api<LifeObject[]>("/api/v1/notes"), api<LifeObject[]>("/api/v1/notes?state=deleted"), api<InboxDrafts>("/api/v1/inbox/drafts")
    ]);
    setToday(nextToday); setTasks(nextTasks); setProjects(nextProjects); setReviews(nextReviews); setHealth(nextHealth); setBackups(nextBackups); setKnowledge(nextKnowledge); setClients(nextClients); setProducts(nextProducts); setPeople(nextPeople); setConnectionSettings(nextSettings); setObjectLinks(nextObjectLinks); setNotes(nextNotes); setDeletedNotes(nextDeletedNotes); setInboxDrafts(nextInboxDrafts);
    setAppliedPatches(await api<AppliedPatch[]>("/api/v1/inbox/patches"));
    // #44: loaded on its own so a failure here never blanks the other panels.
    void api<EnrichmentStatus>("/api/v1/enrichment").then(setEnrichment).catch(() => undefined);
    setPersonLabels(await labelsRequest);
  };

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

  const loadInternalDomains = async () => setInternalDomains(await api<{ domains: string[]; contentHash?: string }>("/api/v1/settings/internal-domains").catch(() => undefined));

  /** #39: saves the synced internal-domains setting; resolves to an error message, or undefined on success. */
  const saveInternalDomains = async (domains: string[]): Promise<string | undefined> => {
    try {
      setInternalDomains(await api<{ domains: string[]; contentHash?: string }>("/api/v1/settings/internal-domains", { method: "PUT", body: JSON.stringify({ domains, expectedHash: internalDomains?.contentHash }) }));
      await loadCollections();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await loadInternalDomains(); return "The internal domains were changed on another device. The latest version is loaded; make your change again."; }
      return error instanceof Error ? error.message : "Could not save internal domains";
    }
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

  const loadCalendarDay = async (date = selectedDate) => {
    const range = dayRange(date, displayTimeZone);
    const nextEvents = await api<Event[]>(`/api/v1/calendar/events?${new URLSearchParams(range)}`);
    setEvents(nextEvents);
    setCalendarError(undefined);
    setCalendarSources((current) => {
      const next = { ...current };
      for (const event of nextEvents) if (event.calendarId) next[event.calendarId] = { name: event.calendarName ?? event.calendarId, color: event.calendarColor };
      return next;
    });
    return nextEvents;
  };

  useEffect(() => {
    void loadCalendarCatalog();
    Promise.all([api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection), loadCollections()])
      .then(async () => {
        const meetingId = localStorage.getItem("lifeos.activeMeetingId");
        if (view === "Calendar" && meetingId) await refreshWorkspace(meetingId).catch(() => localStorage.removeItem("lifeos.activeMeetingId"));
        setMessage("Local workspace ready");
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  const calendarFailed = (error: unknown) => {
    const text = error instanceof Error ? error.message : "Calendar could not be loaded";
    setEvents([]);
    setCalendarError(text);
    // A 401 means Google rejected the tokens; refresh status so the Reconnect banner appears.
    if (error instanceof ApiError && error.status === 401) void api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection).catch(() => undefined);
    return text;
  };

  useEffect(() => {
    loadCalendarDay().catch((error: Error) => setMessage(calendarFailed(error)));
  }, [selectedDate, displayTimeZone]);

  useEffect(() => { localStorage.setItem("lifeos.activeView", view); }, [view]);

  // Re-fetch whichever note/workspace is currently open as soon as the tab regains focus, so an
  // external edit (another device, an agent, Git) is discovered immediately rather than only on
  // the next unrelated list refresh. Both fetches are the same "soft" kind used above — they only
  // update state, so useNoteDraftController's own reconcile effect on note?.contentHash decides
  // whether to resync silently or open the conflict panel. Independent of `view`: a draft stays
  // open (and its autosave keeps running) even after switching away from its editor.
  //
  // The handler reads these through refs (same pattern as activeDraft in useNoteDraftController.ts
  // and rememberedNoteId above) rather than depending on them directly: `workspace` gets a new
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

  // Resume the last-open note on load. Every other path that switches notes (openNote, and the
  // reconcile/autosave effects inside useNoteDraftController) opens its draft explicitly too, so
  // this is the only place a note change needs to prime the controller itself.
  useEffect(() => {
    if (selectedNoteId || !rememberedNoteId.current) return;
    const remembered = notes.find((note) => note.frontmatter.id === rememberedNoteId.current);
    if (!remembered) return;
    const opened = notesController.open(remembered, readCachedDraft(remembered));
    setSelectedNoteId(remembered.frontmatter.id);
    if (opened.conflict) setMessage("Recovered a browser draft, but the Markdown file also changed. Review before saving.");
  }, [notes, selectedNoteId]);

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
  const openEvent = (selectedEvent: Event) => run(async () => {
    const { externalId, calendarId } = selectedEvent;
    const range = dayRange(selectedDate, displayTimeZone);
    const next = await api<Workspace>(`/api/v1/meetings/preview?${new URLSearchParams({ externalId, ...(calendarId ? { calendarId } : {}), ...range })}`);
    setWorkspace(next); setEditorMode("visual"); setEditorSession((current) => current + 1);
    if (next.persisted !== false) {
      localStorage.setItem("lifeos.activeMeetingId", next.meeting.frontmatter.id);
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

  const processMeeting = async () => {
    if (!workspace) return false;
    setBusy(true);
    try {
      if (meetingController.dirty && !(await meetingController.saveNow())) return false;
      const meetingId = meetingController.pending || !workspace.note ? createdWorkspace.current?.meeting.frontmatter.id : workspace.meeting.frontmatter.id;
      if (!meetingId) return false;
      await api(`/api/v1/meetings/${meetingId}/process`, { method: "POST" });
      await refreshWorkspace(meetingId); await loadCollections();
      setMessage("Mock AI proposal created");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally { setBusy(false); }
  };

  const accept = (reviewId: string) => run(async () => {
    await api(`/api/v1/review-items/${reviewId}/accept`, { method: "POST" });
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await loadCollections();
  }, "Task accepted and published");

  const reject = (reviewId: string) => run(async () => {
    await api(`/api/v1/review-items/${reviewId}/reject`, { method: "POST" });
    if (workspace) await refreshWorkspace(workspace.meeting.frontmatter.id);
    await loadCollections();
  }, "Proposal rejected");

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
      setMessage(batch.drafts.length ? `Drafts: ${count("adopted")} adopted, ${count("applied")} patches applied, ${count("duplicate")} already adopted, ${count("failed")} failed, ${count("skipped")} still being written` : "No drafts awaiting adoption");
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

  const changeTask = (task: LifeObject, changes: Record<string, unknown>) => run(async () => {
    await api(`/api/v1/tasks/${task.frontmatter.id}`, { method: "PATCH", body: JSON.stringify({ changes, expectedHash: task.contentHash }) });
    await loadCollections();
  }, "Task updated");

  const ingestSource = () => run(async () => {
    await api("/api/v1/sources/text", { method: "POST", body: JSON.stringify({ title: sourceTitle, text: sourceText }) });
    setSourceTitle(""); setSourceText(""); await loadCollections(); setView("Inbox");
  }, "Source preserved; Knowledge Note proposal added to Inbox");

  const connectGoogle = () => run(async () => {
    const response = await api<{ authorizationUrl: string }>("/api/v1/connections/google/start");
    window.location.assign(response.authorizationUrl);
  }, "Opening Google authorization");

  const syncGoogle = () => run(async () => {
    const range = dayRange(selectedDate, displayTimeZone);
    try { setEvents(await api<Event[]>(`/api/v1/calendar/sync?${new URLSearchParams(range)}`, { method: "POST" })); }
    catch (error) { calendarFailed(error); throw error; }
    setCalendarError(undefined);
    await loadCollections();
  }, "Google Calendar synchronized");

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

  const deleteEntity = (object: LifeObject) => run(async () => {
    await api(`/api/v1/entities/by-id/${object.frontmatter.id}`, { method: "DELETE", body: JSON.stringify({ expectedHash: object.contentHash }) });
    await loadCollections();
  }, `${object.frontmatter.type} moved to deleted state`);

  const saveGoogleSecrets = (provider: "calendar" | "drive", clientId: string, clientSecret: string) => run(async () => {
    await api(`/api/v1/settings/connections/google/${provider}`, { method: "POST", body: JSON.stringify({ clientId, clientSecret }) });
    const settings = await api<ConnectionSettings>("/api/v1/settings/connections");
    setConnectionSettings(settings);
    if (provider === "calendar") setGoogleConnection(await api<GoogleConnection>("/api/v1/connections/google"));
  }, `Google ${provider} credentials saved to Keychain`);

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
    insertMarkdown(`\n\n\`\`\`${language.trim()}\n`, "\n\`\`\`\n\n", selected || "code");
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

  function openNote(note: LifeObject) {
    notesController.open(note, readCachedDraft(note));
    setSelectedNoteId(note.frontmatter.id); setNotesMode("visual");
    localStorage.setItem("lifeos.activeNoteId", note.frontmatter.id);
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
    setSelectedDeletedId(undefined); setNoteTab("open"); setNoteQuery("");
    openNote(restored);
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
    rememberedNoteId.current = undefined;
    localStorage.removeItem("lifeos.activeNoteId");
  });

  const deleteMeetingNote = () => workspace?.note && deleteNote(workspace.note, meetingController, () => {
    const noteId = workspace.note?.frontmatter.id;
    setWorkspace(undefined);
    localStorage.removeItem("lifeos.activeMeetingId");
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
  // first so leaving it can never drop text.
  const openLifeosLink = async (href: string) => {
    try {
      for (const controller of [notesController, meetingController]) {
        if (controller.dirty && !(await controller.saveNow())) { setMessage("Save or resolve the note you are editing, then open the link."); return; }
      }
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
        setView("Notes");
        if (live) { setNoteTab("open"); openNote(live); } else { setNoteTab("deleted"); setSelectedDeletedId(target.id); }
      } else if (target.kind === "meeting") {
        const meeting = objects.find((object) => object.frontmatter.id === target.id);
        setView("Calendar");
        if (meeting?.frontmatter.starts_at) setSelectedDate(dateInTimeZone(new Date(String(meeting.frontmatter.starts_at)), displayTimeZone));
        localStorage.setItem("lifeos.activeMeetingId", target.id);
        await refreshWorkspace(target.id);
      } else if (target.kind === "inbox") {
        setView("Inbox");
      } else {
        setView(target.view);
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
  useEffect(() => { if (view === "Settings") { void loadCalendarCatalog(); void loadInternalDomains(); } }, [view]);

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
        {navigation.map((item) => <button className={item === view ? "active" : ""} key={item} onClick={() => setView(item)}>{item}{item === "Inbox" && pendingReviews.length > 0 ? <em>{pendingReviews.length}</em> : null}</button>)}
      </nav>
      <div className="nav-footer">
        <div className="nav-actions">
          <button className={`settings-link ${view === "Settings" ? "active" : ""}`} onClick={() => setView("Settings")}>Settings</button>
        </div>
        <p className="connection"><i className={readOnly ? "warning-dot" : ""} /> {readOnly ? "Read-only · another device active" : message}</p>
      </div>
    </aside>

    <section className={[(view === "Notes" && notesController.conflict) || (view === "Calendar" && meetingController.conflict) ? "comparing-conflict" : "", view === "Notes" || view === "Calendar" ? "fit-view" : ""].filter(Boolean).join(" ") || undefined}>
      {!server.online && <article className="lease-warning" role="status"><span>LIFEOS SERVER</span><h3>Reconnecting…</h3><p>LifeOS is restarting or not running. Keep typing: your draft is kept in the browser and saves when the server is back.</p></article>}
      {view === "Today" && <>
        <PageHeader eyebrow="HOME / TODAY" title="What needs your attention?" description="A calm view of active work and pending decisions." />
        <div className="summary">
          <Summary label="Active tasks" value={today.tasks.length} detail="across all contexts" />
          <Summary label="Review inbox" value={today.reviewCount} detail="awaiting confirmation" />
          <Summary label="Today's events" value={events.length} detail="across connected calendars" />
        </div>
        <article className="quick-capture"><span>QUICK CAPTURE</span><div className="capture-row"><input value={capture} onChange={(event) => setCapture(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && capture.trim()) submitCapture(); }} placeholder="Capture a task or commitment…" /><button className="primary" disabled={!capture.trim() || busy || readOnly} onClick={submitCapture}>Capture</button></div></article>
        {today.focus ? <DailyFocusPanel focus={today.focus} disabled={busy || readOnly} onRefresh={() => void requestReplan()} />
          : <article><span>SUGGESTED TOP 3</span>{!today.topThree.length && <p className="muted">No active commitments to rank.</p>}{today.topThree.map(({ task, reason }) => <div className="object-row" key={task.frontmatter.id}><i /><div><b>{task.frontmatter.title}</b><small>{reason}</small></div></div>)}</article>}
        <article className="enrichment"><span>AFTER MEETINGS</span><div className="capture-row"><p>Ask Claude to collect transcripts, recordings and Gong material for meetings that ended in the last 48 hours.</p><button className="primary" disabled={busy || readOnly} onClick={() => void requestEnrichment()}>Enrich last 48h</button></div>
          {enrichment.staleWorkOrders.length > 0 && <ul className="diagnostics">{enrichment.staleWorkOrders.map((order) => <li key={order.path}>Work Order not processed for {order.ageDays} days: <code>{order.path}</code></li>)}</ul>}
          {enrichment.proposedGaveUp.map((meeting) => <div className="object-row" key={meeting.meetingId}><i /><div><b>{meeting.title}</b><small>No material 48 hours after the request</small></div><button disabled={busy || readOnly} onClick={() => void giveUpEnrichment(meeting.meetingId)}>Give up</button></div>)}</article>
        <ObjectList title="Overdue" objects={today.overdue} empty="Nothing overdue." />
        <ObjectList title="Due today" objects={today.dueToday} empty="Nothing due today." />
        <ObjectList title="Upcoming priority work" objects={today.upcoming.length ? today.upcoming : today.tasks.filter((task) => task.frontmatter.priority === "High")} empty="No upcoming dated or high-priority work." />
        <ObjectList title="Waiting" objects={today.waiting} empty="Nothing waiting on someone else." />
        <article><span>TODAY'S EVENTS</span>{calendarError ? <p className="muted">Calendar could not be loaded: {calendarError}</p> : !events.length && <p className="muted">No events today.</p>}{events.slice(0, 5).map((event) => <div className="object-row" key={`${event.calendarId ?? "calendar"}:${event.externalId}`}><i /><div><b>{event.title}</b><small>{formatEventDate(event)} · {event.calendarName ?? "Calendar"}</small></div></div>)}</article>
      </>}

      {view === "Calendar" && <>
        <PageHeader eyebrow="CALENDAR / MEETING" title="Meeting workspace" description="Capture in Markdown, review proposed commitments, and publish only what you confirm." />
        {googleConnection?.reason === "expired" && <article className="lease-warning" role="alert"><span>GOOGLE CALENDAR</span><h3>Reconnect Google Calendar</h3><p>Google no longer accepts the saved access, so events cannot sync. {googleConnection.lastSuccessfulSyncAt ? `Last successful sync: ${new Date(googleConnection.lastSuccessfulSyncAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone })}.` : "No successful sync recorded yet."}</p><button className="takeover" disabled={busy} onClick={connectGoogle}>Reconnect</button></article>}
        {googleConnection && !googleConnection.connected && googleConnection.reason !== "expired" && <article className="lease-warning"><span>GOOGLE CALENDAR</span><h3>{googleConnection.configured ? "Ready to connect" : "Configuration required"}</h3><p>{googleConnection.configured ? "Authorize read-only access to replace the mock calendar with your upcoming events." : "Add the Google Calendar OAuth client under Settings, then return here to connect."}</p>{googleConnection.configured ? <button className="takeover" disabled={busy} onClick={connectGoogle}>Connect Google Calendar</button> : <button onClick={() => setView("Settings")}>Open Settings</button>}</article>}
        {googleConnection?.connected && <article className="connection-card"><span>GOOGLE CALENDAR CONNECTED</span><p className="muted">Read-only access is active. Each manual sync records a durable Sync Run.</p><button disabled={busy || readOnly} onClick={syncGoogle}>Sync now</button></article>}
        <div className="meeting-layout split-layout" style={calendarSplit.style}>
          <article className="event-list">
            <div className="event-list-heading"><span>DAY TIMELINE</span><button onClick={() => setSelectedDate(dateInTimeZone(new Date(), displayTimeZone))}>Today</button></div>
            <div className="calendar-controls">
              <label><small>Date</small><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
              <label><small>Calendar</small><select value={calendarFilter} onChange={(event) => setCalendarFilter(event.target.value)}>
                <option value="all">All calendars</option>
                {[...offeredCalendars].sort((left, right) => left.name.localeCompare(right.name)).map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}
              </select></label>
            </div>
            <h3 className="timeline-date">{new Date(`${selectedDate}T12:00:00.000Z`).toLocaleDateString([], { dateStyle: "full", timeZone: displayTimeZone })}</h3>
            {calendarError
              ? <div className="timeline-empty timeline-error" role="alert"><b>Calendar could not be loaded</b><small>{calendarError}</small></div>
              : !filteredEvents.length && <div className="timeline-empty"><b>No events</b><small>This calendar is clear for the selected day.</small></div>}
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
                <div><span>MEETING</span><h3>{workspace.meeting.frontmatter.title}</h3></div>
                <div className="context-grid">
                  <Meta label="When" value={workspace.meeting.frontmatter.is_all_day === true ? `${String(workspace.meeting.frontmatter.starts_at).slice(0, 10)} · All day` : formatDate(workspace.meeting.frontmatter.starts_at)} />
                  <Meta label="Project" value={workspace.context.project?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Client" value={workspace.context.client?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Product" value={workspace.context.product?.frontmatter.title ?? "Not linked"} />
                  <PeopleMeta label="Attendees" people={workspace.context.people} labels={labels} empty="None" />
                </div>
              </article>
              {workspace.note && meetingController.conflict ? <NoteConflictPanel noteTitle={workspace.note.frontmatter.title} draftText={meetingController.draft} diskText={workspace.note.body} disabled={busy || readOnly} onKeepBrowserVersion={() => withBusy(meetingController.keepBrowserVersion)} onKeepDiskVersion={() => withBusy(meetingController.keepDiskVersion)} /> :
              <article className="editor-card">
                {workspace.note
                  ? <NoteHeader note={workspace.note} kind="CANONICAL NOTE" {...headerOptions} disabled={busy || readOnly || meetingController.autoSaving} onSave={saveMeetingNoteDetails}><div className="mode-switch"><button className={editorMode === "visual" ? "selected" : ""} onClick={() => setEditorMode("visual")}>Visual</button><button className={editorMode === "write" ? "selected" : ""} onClick={() => setEditorMode("write")}>Markdown</button><button className={editorMode === "preview" ? "selected" : ""} onClick={() => setEditorMode("preview")}>Preview</button></div></NoteHeader>
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
                  <div className="actions">{workspace.note && <button className="danger" disabled={busy || readOnly || meetingController.autoSaving} onClick={deleteMeetingNote}>Delete note</button>}<button disabled={!editorReady || busy || !meetingController.dirty || readOnly} onClick={saveNote}>Save Markdown</button><button className="primary" disabled={!editorReady || busy || !meetingController.draft.trim() || readOnly} onClick={processMeeting}>Save & process</button></div>
                </div>
                {workspace.note && <div className="metadata-strip"><Meta label="Created" value={formatDate(workspace.note.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(workspace.note.frontmatter.updated_at)} /><Meta label="Revision" value={String(workspace.note.frontmatter.revision)} /><Meta label="File" value={workspace.note.relativePath} /></div>}
              </article>}
              <article><span>REVIEW BEFORE PUBLISHING</span><h3>Meeting proposals</h3>
                {!workspace.reviews.length && <p className="muted">Process the note to create a durable review item.</p>}
                {workspace.reviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review.frontmatter.id)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} />)}
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
              <button role="tab" aria-selected={noteTab === "open"} className={noteTab === "open" ? "selected" : ""} onClick={() => setNoteTab("open")}>Open <small>{notes.length}</small></button>
              <button role="tab" aria-selected={noteTab === "deleted"} className={noteTab === "deleted" ? "selected" : ""} onClick={() => setNoteTab("deleted")}>Deleted <small>{deletedNotes.length}</small></button>
            </div>
            <input className="notes-search" type="search" aria-label="Search notes" placeholder={noteTab === "open" ? "Search notes…" : "Search deleted notes…"} value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} />
            {!visibleNotes.length && <p className="muted">{noteQuery.trim() ? `No ${noteTab} notes match “${noteQuery.trim()}”.` : noteTab === "open" ? "No notes have been created yet." : "No deleted notes."}</p>}
            {groupByDay(visibleNotes, (note) => noteTab === "open" ? note.frontmatter.updated_at : String(note.frontmatter.deleted_at), displayTimeZone).map((group) => <div className="note-day-group" key={group.key}><h4 className="note-day-label">{group.label}</h4>{group.items.map((note) => <button className={note.frontmatter.id === (noteTab === "open" ? selectedNoteId : selectedDeletedId) ? "note-list-item selected" : "note-list-item"} key={note.frontmatter.id} onClick={() => noteTab === "open" ? openNote(note) : setSelectedDeletedId(note.frontmatter.id)}>
              <b>{note.frontmatter.title}<LockBadge frontmatter={note.frontmatter} />{noteTab === "open" && conflictedNoteIds.has(note.frontmatter.id) && <ConflictBadge />}</b><small>{note.frontmatter.type === "meeting-note" ? "Meeting note" : "Knowledge note"} · {noteTab === "open" ? formatTime(note.frontmatter.updated_at) : `Deleted ${formatTime(String(note.frontmatter.deleted_at))}`}</small><span>{note.body.replace(/[#>*_`\[\]-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110) || "Empty note"}</span>
            </button>)}</div>)}
          </article>
          <div {...notesSplit.dividerProps} />
          <div className="notes-main">
            {noteTab === "deleted" ? (!selectedDeleted ? <article className="empty-state"><h3>Select a deleted note</h3><p>Deleted notes are kept on disk. Choose one to read it or restore it.</p></article> : <article className="editor-card">
              <div className="editor-heading"><div><span>DELETED {selectedDeleted.frontmatter.type.replace("-", " ").toUpperCase()}</span><h3>{selectedDeleted.frontmatter.title}</h3></div></div>
              <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{selectedDeleted.body || "_Empty note._"}</ReactMarkdown></div>
              <div className="editor-footer"><div className="save-state"><i className="dirty" />Deleted {formatDate(String(selectedDeleted.frontmatter.deleted_at))} · read-only</div><div className="actions"><button className="primary" disabled={busy || readOnly} onClick={() => restoreNote(selectedDeleted)}>Restore note</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedDeleted.frontmatter.created_at)} /><Meta label="Deleted" value={formatDate(String(selectedDeleted.frontmatter.deleted_at))} /><Meta label="Revision" value={String(selectedDeleted.frontmatter.revision)} /><Meta label="File" value={selectedDeleted.relativePath} /></div>
            </article>) :
            selectedNote && notesController.conflict ? <NoteConflictPanel noteTitle={selectedNote.frontmatter.title} draftText={notesController.draft} diskText={selectedNote.body} disabled={busy || readOnly} onKeepBrowserVersion={() => withBusy(notesController.keepBrowserVersion)} onKeepDiskVersion={() => withBusy(notesController.keepDiskVersion)} /> :
            !selectedNote ? <article className="empty-state"><h3>Select a note</h3><p>Choose a recent note to view or edit its Markdown.</p></article> : <article className={notesEditorBox.resized ? "editor-card notes-editor resized" : "editor-card notes-editor"} style={notesEditorBox.style}>
              <NoteHeader note={selectedNote} kind={selectedNote.frontmatter.type.replace("-", " ").toUpperCase()} {...headerOptions} disabled={busy || readOnly || notesController.autoSaving} onSave={saveNotesDetails}><div className="mode-switch"><button className={notesMode === "visual" ? "selected" : ""} onClick={() => setNotesMode("visual")}>Visual</button><button className={notesMode === "write" ? "selected" : ""} onClick={() => setNotesMode("write")}>Markdown</button><button className={notesMode === "preview" ? "selected" : ""} onClick={() => setNotesMode("preview")}>Preview</button></div></NoteHeader>
              {notesMode === "write" ? <>
                <div className="toolbar">
                  <select disabled={readOnly} aria-label="Heading level" defaultValue="" onChange={(event) => { if (event.target.value) transformNoteLines((line) => `${"#".repeat(Number(event.target.value))} ${line.replace(/^#{1,6}\s+/, "")}`, "Heading"); event.target.value = ""; }}><option value="" disabled>Heading</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option><option value="4">H4</option></select>
                  <button disabled={readOnly} title="Bold" onClick={() => editNotes("**", "**")}>B</button><button disabled={readOnly} title="Italic" onClick={() => editNotes("*", "*")}><i>I</i></button><button disabled={readOnly} title="Inline code" onClick={() => editNotes("`", "`", "code")}>{"</>"}</button>
                  <button disabled={readOnly} title="Fenced code block" onClick={() => { const language = window.prompt("Code language", "typescript"); if (language !== null) editNotes(`\n\n\`\`\`${language.trim()}\n`, "\n\`\`\`\n\n", "code"); }}>Code block</button>
                  <button disabled={readOnly} title="Bulleted list" onClick={() => transformNoteLines((line) => `- ${line.replace(/^[-*+]\s+/, "")}`)}>• List</button><button disabled={readOnly} title="Numbered list" onClick={() => transformNoteLines((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`)}>1. List</button><button disabled={readOnly} title="Task checkbox" onClick={() => transformNoteLines((line) => `- [ ] ${line.replace(/^- \[[ xX]\]\s+/, "")}`)}>☐ Task</button><button disabled={readOnly} title="Blockquote" onClick={() => transformNoteLines((line) => `> ${line.replace(/^>\s?/, "")}`)}>❯ Quote</button>
                  <button disabled={readOnly} title="Link" onClick={() => editNotes("[", "](https://)", "link text")}>Link</button><button disabled={readOnly || busy} title="Upload image" onClick={() => notesImageInput.current?.click()}>Image</button><input ref={notesImageInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadNotesImage(file); event.target.value = ""; }} />
                  <button disabled={readOnly} title="Horizontal divider" onClick={() => insertNotes("\n\n---\n\n")}>―</button><button disabled={readOnly} title="Insert table" onClick={() => insertNotes("\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |\n\n")}>Table</button>
                  <select disabled={readOnly} aria-label="Link a LifeOS object" defaultValue="" onChange={(event) => { const object = objectLinks.find((candidate) => candidate.frontmatter.id === event.target.value); if (object) insertNotes(`[${object.frontmatter.title}](lifeos://object/${object.frontmatter.id})`); event.target.value = ""; }}><option value="" disabled>Link object…</option>{objectLinks.filter((object) => !object.frontmatter.deleted_at).sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title)).map((object) => <option key={object.frontmatter.id} value={object.frontmatter.id}>{object.frontmatter.type} · {object.frontmatter.title}</option>)}</select>
                </div>
                <textarea ref={notesEditor} disabled={busy || readOnly} value={notesController.draft} onChange={(event) => notesController.setDraft(event.target.value)} onPaste={(event) => { const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} placeholder="Write Markdown… Paste or drop an image here." />
              </> : notesMode === "visual" ? <VisualMarkdownEditor editorKey={selectedNote.frontmatter.id} owner={{ id: selectedNote.frontmatter.id, relativePath: selectedNote.relativePath }} markdown={notesController.draft} readOnly={busy || readOnly} onChange={notesController.setDraft} /> : <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepLifeosLinks} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{notesController.draft || "_Nothing to preview yet._"}</ReactMarkdown></div>}
              <div className="editor-footer"><div className="save-state"><i className={notesController.dirty ? "dirty" : "saved"} />{notesController.dirty ? notesController.autoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}{notesController.undoAvailable && <button disabled={busy || readOnly} onClick={() => withBusy(notesController.undoKeepDiskVersion)}>Undo "Keep disk version"</button>}</div><div className="actions"><button className="danger" disabled={busy || readOnly || notesController.autoSaving} onClick={deleteSelectedNote}>Delete note</button><button className="primary" disabled={busy || readOnly || !notesController.dirty} onClick={saveSelectedNote}>Save now</button></div></div>
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedNote.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(selectedNote.frontmatter.updated_at)} /><Meta label="Revision" value={String(selectedNote.frontmatter.revision)} /><Meta label="File" value={selectedNote.relativePath} /></div>
              <div {...notesEditorBox.handleProps} />
            </article>}
          </div>
        </div>
      </>}

      {view === "Tasks" && <EntityCrudPage labels={labels} highlightId={highlightId} type="task" title="Tasks" objects={tasks} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}

      {view === "Projects" && <><PageHeader eyebrow="PROJECTS" title="Project roll-ups" description="Meetings and tasks are computed from stable relationships, not copied lists." />
        <EntityCrudPage labels={labels} highlightId={highlightId} embedded type="project" title="Projects" objects={projects.map(({ project }) => project)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />
        <div className="project-grid">{projects.map(({ project, tasks: projectTasks, meetings, decisions, openPoints, people: projectPeople }) => <article key={project.frontmatter.id}><span>PROJECT</span><h3>{project.frontmatter.title}</h3><p className="muted">{String(project.frontmatter.objective ?? "No objective")}</p><div className="project-stats"><b>{projectTasks.length}<small>tasks</small></b><b>{openPoints.filter((point) => point.frontmatter.status === "open").length}<small>open points</small></b><b>{decisions.length}<small>decisions</small></b><b>{meetings.length}<small>meetings</small></b></div><p className="muted">People: {projectPeople.length ? <PeopleList people={projectPeople} labels={labels} /> : "None linked"}</p></article>)}</div>
        {!projects.length && <article className="empty-state"><h3>No projects yet</h3><p>Opening the mock calendar event will create its linked project context.</p></article>}
      </>}

      {view === "Decisions" && <DecisionsPage projects={projects.map(({ project }) => project)} clients={clients.map(({ entity }) => entity)} products={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} timeZone={displayTimeZone} highlightId={highlightId} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onChanged={loadCollections} formatDate={formatDate} />}
      {view === "Open Points" && <OpenPointsPage projects={projects.map(({ project }) => project)} clients={clients.map(({ entity }) => entity)} products={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} timeZone={displayTimeZone} highlightId={highlightId} run={run} onOpen={(id) => void openLifeosLink(`lifeos://object/${id}`)} onChanged={loadCollections} formatDate={formatDate} />}

      {view === "Clients" && <EntityCrudPage labels={labels} highlightId={highlightId} type="client" title="Clients" objects={clients.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}
      {view === "Products" && <EntityCrudPage labels={labels} highlightId={highlightId} type="product" title="Products" objects={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}
      {view === "People" && <EntityCrudPage labels={labels} onSetExternal={setPersonExternal} highlightId={highlightId} type="person" title="People" objects={people.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}

      {view === "Inbox" && <><PageHeader eyebrow="INBOX" title="Review proposals" description="Nothing becomes a commitment until you accept it." />
        <article className="inbox-drafts"><span>AGENT DRAFTS</span><div className="capture-row"><p><b>{inboxDrafts.awaiting}</b> {inboxDrafts.awaiting === 1 ? "draft" : "drafts"} awaiting adoption</p><button className="primary" disabled={busy || readOnly} onClick={() => void adoptDrafts()}>Adopt now</button></div>
          {inboxDrafts.failed.length > 0 && <><p>Failed drafts are kept in <code>_inbox/failed/</code>. Fix and re-send them, or remove the file.</p><ul className="diagnostics">{inboxDrafts.failed.map((entry) => <li key={entry.path}>{entry.reason}</li>)}</ul></>}</article>
        {appliedPatches.length > 0 && <article className="inbox-drafts"><span>APPLIED CHANGES</span><ul className="diagnostics">{appliedPatches.slice(0, 20).map((patch) => <li key={patch.auditEventId}><div className="capture-row"><p><b>{patch.title}</b>: {[...Object.keys(patch.after).map((field) => `${field} ${String(patch.before[field] ?? "none")} → ${String(patch.after[field] ?? "none")}`), ...(patch.appendedNote ? [`note added: "${patch.appendedNote}"`] : [])].join("; ") || "no change"}</p>{patch.undone ? <em>Undone</em> : <button disabled={busy || readOnly} onClick={() => void undoPatch(patch)}>Undo</button>}</div></li>)}</ul></article>}
        {!pendingReviews.length && <article className="empty-state"><h3>Inbox clear</h3><p>No proposals require your attention.</p></article>}
        {pendingReviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review.frontmatter.id)} onReject={() => reject(review.frontmatter.id)} onSave={(changes) => editReview(review.frontmatter.id, changes)} choices={headerOptions} evidence={reviews.find((item) => item.frontmatter.id === review.frontmatter.id)?.evidence} />)}
      </>}

      {view === "Knowledge" && <><PageHeader eyebrow="KNOWLEDGE" title="Knowledge workspace" description="Preserve pasted source text, then review a linked Knowledge Note before publishing it." /><article><span>ADD RAW TEXT SOURCE</span><div className="knowledge-form"><input value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} placeholder="Source title" /><textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="Paste source text or Markdown…" /><button className="primary" disabled={busy || readOnly || !sourceTitle.trim() || !sourceText.trim()} onClick={ingestSource}>Preserve & process</button></div></article><ObjectList title="Published Knowledge Notes" objects={knowledge} empty="No Knowledge Notes have been accepted yet." /><p className="muted">Image and attachment handling remains intentionally low priority.</p></>}

      {view === "System" && <><PageHeader eyebrow="SYSTEM" title="Health and device handoff" description="Integrity checks and an advisory lease protect the Markdown root during sequential two-device use." />
        <div className="summary">
          <Summary label="Object graph" value={health?.diagnostics.length ? "Attention" : "Healthy"} detail={`${health?.objectCount ?? 0} indexed objects`} />
          <Summary label="Write access" value={readOnly ? "Read-only" : "Enabled"} detail={readOnly ? "another device lease is active" : "revision checks remain active"} />
          <Summary label="Device" value={health?.session.currentDeviceId ?? "—"} detail="this installation" />
        </div>
        {readOnly && <article className="lease-warning"><span>DEVICE HANDOFF REQUIRED</span><h3>{health?.session.activeDeviceId} is still active</h3><p>{health?.session.warning}</p><p>Only take over after LifeOS is closed and Google Drive has finished synchronizing on the other computer.</p><button className="takeover" disabled={busy} onClick={takeOverSession}>Take over write access</button></article>}
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

      {view === "Settings" && <><PageHeader eyebrow="SETTINGS / CONNECTIONS" title="Connections and preferences" description="Credentials are write-only from this screen and stored in macOS Keychain, never Markdown or Git." /><article className="timezone-setting"><span>DISPLAY TIMEZONE</span><h3>{displayTimeZone}</h3><p className="muted">Timestamps remain portable UTC instants. LifeOS displays them in this device-specific IANA timezone, including daylight-saving changes.</p><select value={displayTimeZone} onChange={(event) => { localStorage.setItem("lifeos.displayTimeZone", event.target.value); setDisplayTimeZone(event.target.value); }}>{availableTimeZones.map((zone) => <option key={zone}>{zone}</option>)}</select></article><CalendarListCard catalog={calendarCatalog} loaded={calendarCatalogLoaded} prefs={calendarPrefs} onSave={saveCalendarPrefs} /><InternalDomainsCard setting={internalDomains} disabled={readOnly} onSave={saveInternalDomains} /><div className="settings-grid"><GoogleSecretCard provider="calendar" title="Google Calendar" status={connectionSettings?.calendar} busy={busy || readOnly} onSave={saveGoogleSecrets} /><GoogleSecretCard provider="drive" title="Google Drive" status={connectionSettings?.drive} busy={busy || readOnly} onSave={saveGoogleSecrets} /></div><article><span>SECURITY</span><p className="muted">LifeOS only reports whether credentials exist. Saved client secrets cannot be read back through the API or UI. Calendar authorization happens from the Calendar page after its credentials are configured.</p></article></>}
    </section>
  </main>;
}

function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p className="lede">{description}</p></header>;
}
function Summary({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
/**
 * #46: the morning brief with live status, in the agreed order: I owe → Top 3 → waiting/decisions →
 * meeting prep → day shape. Finished items are struck through (the server already sank them), past
 * meetings are marked, and deleted references show as missing. Without a brief, the rule's Top 3 shows.
 */
function DailyFocusPanel({ focus, disabled, onRefresh }: { focus: DailyFocus; disabled: boolean; onRefresh: () => void }) {
  const stateLabel = { open: "", done: "Done", cancelled: "Cancelled", past: "Past", missing: "Missing: deleted or not found" } as const;
  const row = (item: FocusItem, details: Array<string | undefined>) => <div className={`object-row focus-item ${item.state}`} key={item.id}><i /><div><b>{item.object?.frontmatter.title ?? "Missing item"}</b><small>{[stateLabel[item.state], ...details].filter(Boolean).join(" · ")}</small></div></div>;
  const section = (title: string, items: FocusItem[], details: (item: FocusItem) => Array<string | undefined>, empty: string) => <div className="focus-section"><h4>{title}</h4>{items.length ? items.map((item) => row(item, details(item))) : <p className="muted">{empty}</p>}</div>;
  const { brief } = focus;
  return <article className="daily-focus">
    <span>DAILY FOCUS</span>
    <div className="capture-row"><p className="muted">{brief ? `Generated at ${formatTime(brief.generatedAt)}` : "No brief for today yet. Top 3 suggested by priority, then due date."}</p><button disabled={disabled} onClick={onRefresh} title="Ask Claude to re-plan today">Refresh</button></div>
    {brief && section("I owe", focus.iOwe, (item) => [item.overdue && item.state === "open" ? "Overdue" : undefined], "Nothing owed today.")}
    {section("Top 3", focus.top3, (item) => [item.whyToday, item.ifThen], "No active commitments to rank.")}
    {brief && <>
      {section("Waiting and decisions", focus.waitingAndDecisions, (item) => [item.ageDays !== undefined ? `${item.ageDays} days` : undefined], "Nothing to chase.")}
      {section("Meeting prep", focus.meetingPrep, (item) => [item.object?.frontmatter.starts_at ? formatTime(item.object.frontmatter.starts_at) : undefined, item.context, item.ask ? `Your ask: ${item.ask}` : undefined], "No meetings to prepare.")}
      {focus.dayShape && <div className="focus-section"><h4>Day shape</h4><p>{focus.dayShape.meetingHours} h in meetings · {focus.dayShape.freeHours} h free</p></div>}
      {focus.deferCandidates.length > 0 && section("Consider deferring", focus.deferCandidates, (item) => [item.reason], "")}
      {brief.body.trim() && <p className="focus-narrative">{brief.body.trim()}</p>}
    </>}
    {focus.restrictedHidden > 0 && <p className="muted">{focus.restrictedHidden} restricted {focus.restrictedHidden === 1 ? "item" : "items"} not shown.</p>}
  </article>;
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
  return <article><span>{title.toUpperCase()}</span>{!objects.length && <p className="muted">{empty}</p>}{objects.map((object) => <div className="object-row" key={object.frontmatter.id}><i /><div><b>{object.frontmatter.title}<LockBadge frontmatter={object.frontmatter} /></b><small>{object.frontmatter.status ?? object.frontmatter.type} · Updated {formatDate(object.frontmatter.updated_at)}</small></div></div>)}</article>;
}

const entityFields: Record<EntityType, Array<{ key: string; label: string; kind?: "select" | "date" | "person"; options?: string[] }>> = {
  task: [{ key: "status", label: "Status", kind: "select", options: ["Inbox", "Next", "Waiting", "Done", "Cancelled"] }, { key: "priority", label: "Priority", kind: "select", options: ["", "High", "Medium", "Low"] }, { key: "owner_person_id", label: "Owner", kind: "person" }, { key: "waiting_for_person_id", label: "Waiting for", kind: "person" }, { key: "due_on", label: "Due date", kind: "date" }, { key: "expected_output", label: "Expected output" }],
  project: [{ key: "status", label: "Status" }, { key: "objective", label: "Objective" }, { key: "success_criteria", label: "Success criteria" }, { key: "owner_person_id", label: "Owner", kind: "person" }, { key: "target_end_on", label: "Target end", kind: "date" }],
  client: [{ key: "status", label: "Status" }, { key: "summary", label: "Summary" }, { key: "website_url", label: "Website" }, { key: "primary_contact_person_id", label: "Primary contact", kind: "person" }],
  product: [{ key: "status", label: "Status" }, { key: "description", label: "Description" }, { key: "owner_person_id", label: "Owner", kind: "person" }],
  person: [{ key: "given_name", label: "Given name" }, { key: "family_name", label: "Family name" }, { key: "organization_name", label: "Organization" }, { key: "job_title", label: "Job title" }, { key: "timezone", label: "Timezone" }]
};

// #30: every entity can carry an agreed Area and be marked restricted. A legacy Area shows as "None"
// in the picker but is kept on save unless the user picks a new one (the server allows unchanged legacy values).
const envelopeEntityFields = [{ key: "area", label: "Area", kind: "select" as const, options: ["", ...areaOptions] }, { key: "sensitivity", label: "Sensitivity", kind: "select" as const, options: ["normal", "restricted"] }];

function EntityCrudPage({ type, title, objects, people, labels, onSetExternal, busy, readOnly, embedded = false, highlightId, onCreate, onUpdate, onDelete }: { type: EntityType; title: string; objects: LifeObject[]; people: LifeObject[]; labels: Map<string, PersonLabel>; onSetExternal?: (object: LifeObject, choice: ExternalChoice) => void; busy: boolean; readOnly: boolean; embedded?: boolean; highlightId?: string; onCreate: (type: EntityType, fields: Record<string, unknown>) => void; onUpdate: (object: LifeObject, fields: Record<string, unknown>) => void; onDelete: (object: LifeObject) => void }) {
  const [newTitle, setNewTitle] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => setDrafts(Object.fromEntries(objects.map((object) => [object.frontmatter.id, { ...object.frontmatter }]))), [objects]);
  const setField = (id: string, key: string, value: unknown) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  const create = () => { onCreate(type, { title: newTitle }); setNewTitle(""); };
  return <>{!embedded && <PageHeader eyebrow={type.toUpperCase()} title={title} description={`Create, inspect, edit, archive through history, and soft-delete ${title.toLowerCase()} stored as typed Markdown.`} />}<article className="crud-panel"><span>{embedded ? "MANAGE PROJECTS" : `MANAGE ${title.toUpperCase()}`}</span><div className="capture-row"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTitle.trim()) create(); }} placeholder={`New ${type} title`} /><button className="primary" disabled={busy || readOnly || !newTitle.trim()} onClick={create}>Create</button></div>{!objects.length && <p className="muted">No {title.toLowerCase()} yet.</p>}<div className="crud-list">{objects.map((object) => { const draft = drafts[object.frontmatter.id] ?? object.frontmatter; return <div className={object.frontmatter.id === highlightId ? "crud-card highlighted" : "crud-card"} id={`object-${object.frontmatter.id}`} key={object.frontmatter.id}><div className="crud-fields"><label><small>Title</small><input value={String(draft.title ?? "")} onChange={(event) => setField(object.frontmatter.id, "title", event.target.value)} /></label>{[...entityFields[type], ...envelopeEntityFields].map((field) => <label key={field.key}><small>{field.label}</small>{field.kind === "select" ? <select value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)}>{field.options!.map((option) => <option value={option} key={option}>{option || "None"}</option>)}</select> : field.kind === "person" ? <select value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)}><option value="">None</option>{people.map((person) => <option value={person.frontmatter.id} key={person.frontmatter.id}>{personLabel(labels, person).label}</option>)}</select> : <input type={field.kind === "date" ? "date" : "text"} value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)} />}</label>)}</div><div className="crud-actions">{type === "person" && <PersonExternalControl person={object} labels={labels} disabled={busy || readOnly} onChange={onSetExternal} />}<EnvelopeBadges frontmatter={object.frontmatter} /><small>Revision {object.frontmatter.revision} · {formatDate(object.frontmatter.updated_at)}</small><button disabled={busy || readOnly} onClick={() => onUpdate(object, draft)}>Save changes</button><button className="danger" disabled={busy || readOnly || object.frontmatter.is_self === true} onClick={() => { if (window.confirm(`Soft-delete ${object.frontmatter.title}? The Markdown file will be retained.`)) onDelete(object); }}>Delete</button></div></div>; })}</div></article></>;
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

/** #39: the synced internal-domains setting. People with addresses only on other domains are shown as External. */
function InternalDomainsCard({ setting, disabled, onSave }: { setting?: { domains: string[]; contentHash?: string }; disabled: boolean; onSave: (domains: string[]) => Promise<string | undefined> }) {
  const saved = setting?.domains.join(", ") ?? "";
  const [text, setText] = useState(saved);
  const [status, setStatus] = useState<{ kind: "saved" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const domains = parseDomains(text);
  const dirty = domains.join("|") !== (setting?.domains ?? []).join("|");
  const save = async () => {
    setSaving(true);
    const error = await onSave(domains);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. People labels now use these domains." });
  };
  return <article className="internal-domains-setting"><span>PEOPLE</span><h3>Internal domains</h3>
    <p className="muted">Email domains of your own organisations, separated by commas. Anyone with addresses only on other domains is shown as "Name<span className="ext-suffix"> - ext</span>". You can override this on each person.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><input aria-label="Internal domains" value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setStatus(undefined); }} placeholder="eagleeye.com, untienots.com" /><button type="button" disabled={disabled || saving || !dirty || !domains.length} onClick={save}>{saving ? "Saving…" : "Save"}</button></div>}
    {setting && !domains.length && <p className="calendar-error" role="alert">Enter at least one domain.</p>}
    {status && <small className={status.kind === "error" ? "calendar-error" : "calendar-saved"} role={status.kind === "error" ? "alert" : "status"}>{status.text}</small>}
  </article>;
}

function CalendarListCard({ catalog, loaded, prefs, onSave }: { catalog: CalendarOption[]; loaded: boolean; prefs: CalendarPrefs; onSave: (prefs: CalendarPrefs) => Promise<string | undefined> }) {
  // Edits stay in this draft until Save, so a half-finished change (for example, nothing ticked) is never stored.
  const [disabled, setDisabled] = useState(prefs.disabledCalendarIds);
  const [defaultId, setDefaultId] = useState(prefs.defaultCalendarId);
  const [status, setStatus] = useState<{ kind: "saved" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDisabled(prefs.disabledCalendarIds); setDefaultId(prefs.defaultCalendarId); }, [prefs]);

  const selectedCount = catalog.filter((calendar) => !disabled.includes(calendar.id)).length;
  const allSelected = catalog.length > 0 && selectedCount === catalog.length;
  const noneSelected = catalog.length > 0 && selectedCount === 0;
  const dirty = defaultId !== prefs.defaultCalendarId || [...disabled].sort().join("|") !== [...prefs.disabledCalendarIds].sort().join("|");
  const defaultOff = Boolean(defaultId) && disabled.includes(defaultId!);
  const edit = <T,>(setter: (value: T) => void, value: T) => { setter(value); setStatus(undefined); };

  const save = async () => {
    setSaving(true);
    const error = await onSave({ ...prefs, disabledCalendarIds: disabled, defaultCalendarId: defaultId });
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. Your other devices will pick this up when the data folder syncs." });
  };

  return <article className="calendar-list-setting"><span>CALENDARS</span><h3>Calendars in the Calendar view</h3>
    <p className="muted">Tick the calendars to include. Hover a calendar to make it the default; the Calendar view opens on it.</p>
    {!loaded && <p className="muted">Loading calendars…</p>}
    {loaded && !catalog.length && <p className="muted">No calendars available. Connect Google Calendar to choose from your calendars.</p>}
    {catalog.length > 0 && <div className="calendar-toolbar">
      <button type="button" onClick={() => edit(setDisabled, allSelected ? catalog.map((calendar) => calendar.id) : [])}>{allSelected ? "Unselect all" : "Select all"}</button>
      <small className="muted">{selectedCount} of {catalog.length} selected</small>
    </div>}
    {catalog.map((calendar) => {
      const enabled = !disabled.includes(calendar.id);
      const isDefault = defaultId === calendar.id;
      return <div className="calendar-row" key={calendar.id}>
        <label><input type="checkbox" checked={enabled} onChange={(event) => edit(setDisabled, event.target.checked ? disabled.filter((id) => id !== calendar.id) : [...disabled, calendar.id])} /><i style={{ background: calendar.color ?? "#9aa39d" }} />{calendar.name}{isDefault && <b className="calendar-default-badge">Default</b>}</label>
        {enabled && <span className="calendar-row-actions">
          {isDefault
            ? <button type="button" onClick={() => edit(setDefaultId, undefined)}>Remove default</button>
            : <button type="button" onClick={() => edit(setDefaultId, calendar.id)}>Set as default</button>}
        </span>}
      </div>;
    })}
    {noneSelected && <p className="calendar-error" role="alert">Select at least one calendar. You can't save with none selected.</p>}
    {defaultOff && !noneSelected && <p className="muted" role="status">The default calendar is unticked, so the Calendar view will open on All calendars.</p>}
    {catalog.length > 0 && <div className="calendar-save">
      <button type="button" disabled={!dirty || noneSelected || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      {dirty && !status && !noneSelected && <small className="muted">Unsaved changes</small>}
      {status && <small className={status.kind === "error" ? "calendar-error" : "calendar-saved"} role={status.kind === "error" ? "alert" : "status"}>{status.text}</small>}
    </div>}
  </article>;
}

function GoogleSecretCard({ provider, title, status, busy, onSave }: { provider: "calendar" | "drive"; title: string; status?: { configured: boolean; connected: boolean }; busy: boolean; onSave: (provider: "calendar" | "drive", clientId: string, clientSecret: string) => Promise<boolean> }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setSaved(false);
    if (await onSave(provider, clientId, clientSecret)) {
      setClientId(""); setClientSecret(""); setSaved(true);
    }
  };
  return <article className="secret-card"><span>{title.toUpperCase()}</span><h3>{status?.configured ? "Credentials configured" : "Credentials required"}</h3><p className="muted">{status?.connected ? "Connected" : provider === "calendar" ? "Configure here, then authorize from Calendar." : "Stored for the upcoming Drive source connector."}</p>{saved && <div className="inline-success">Saved securely in macOS Keychain.</div>}<div className="knowledge-form"><input value={clientId} onChange={(event) => { setSaved(false); setClientId(event.target.value); }} placeholder="OAuth client ID" autoComplete="off" /><input type="password" value={clientSecret} onChange={(event) => { setSaved(false); setClientSecret(event.target.value); }} placeholder={status?.configured ? "Enter a new secret to replace it" : "OAuth client secret"} autoComplete="new-password" /><button className="primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={save}>{busy ? "Saving…" : status?.configured ? "Replace credentials" : "Save to Keychain"}</button></div></article>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
