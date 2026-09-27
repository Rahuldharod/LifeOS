import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./styles.css";
import { noteDraftBase, noteSaveRequest, openNoteDraft, reconcileNoteDraft, type NoteDraftBase } from "./noteDraft.js";

type CrepeInstance = {
  create(): Promise<unknown>;
  destroy(): Promise<unknown>;
  setReadonly(value: boolean): unknown;
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
  meeting: LifeObject;
  note?: LifeObject;
  reviews: LifeObject[];
  tasks: LifeObject[];
  context: { project?: LifeObject; client?: LifeObject; product?: LifeObject; people: LifeObject[] };
};
type Today = { tasks: LifeObject[]; overdue: LifeObject[]; dueToday: LifeObject[]; upcoming: LifeObject[]; waiting: LifeObject[]; topThree: Array<{ task: LifeObject; reason: string }>; reviewCount: number };
type ProjectRollup = { project: LifeObject; tasks: LifeObject[]; meetings: LifeObject[]; decisions: LifeObject[]; openPoints: LifeObject[]; people: LifeObject[] };
type EntityRollup = { entity: LifeObject; related: LifeObject[] };
type SessionStatus = { currentDeviceId: string; activeDeviceId: string; startedAt: string; lastActivityAt: string; leaseExpiresAt: string; writeAllowed: boolean; warning?: string };
type SystemHealth = { status: "healthy" | "attention"; objectCount: number; diagnostics: string[]; session: SessionStatus };
type BackupSummary = { backupId: string; createdAt: string; fileCount: number; totalBytes: number };
type BackupVerification = BackupSummary & { valid: boolean; restoredToTemporaryDirectory: boolean; diagnostics: string[] };
type GoogleConnection = { configured: boolean; connected: boolean; provider: string; missing?: string[] };
type ConnectionSettings = { calendar: { configured: boolean; connected: boolean }; drive: { configured: boolean; connected: boolean } };
type EntityType = "task" | "project" | "client" | "product" | "person";
type ObjectLink = Pick<LifeObject, "frontmatter" | "relativePath" | "contentHash">;
type StoredAsset = { relativePath: string; markdownPath: string; sha256: string; deduplicated: boolean; mimeType: string };
type View = "Today" | "Calendar" | "Notes" | "Tasks" | "Projects" | "Clients" | "Products" | "People" | "Knowledge" | "Inbox" | "System" | "Settings";
type CachedDraft = { body: string; baseHash: string; cachedAt: string };

const views: View[] = ["Today", "Calendar", "Notes", "Tasks", "Projects", "Clients", "Products", "People", "Knowledge", "Inbox", "System", "Settings"];
const draftKey = (id: string) => `lifeos.draft.${id}`;

function readCachedDraft(note: LifeObject) {
  try {
    const cached = JSON.parse(localStorage.getItem(draftKey(note.frontmatter.id)) ?? "null") as CachedDraft | null;
    return cached && typeof cached.body === "string" && cached.body !== note.body ? cached : undefined;
  } catch { return undefined; }
}

function cacheDraft(id: string, body: string, baseHash: string) {
  try { localStorage.setItem(draftKey(id), JSON.stringify({ body, baseHash, cachedAt: new Date().toISOString() } satisfies CachedDraft)); }
  catch { /* Markdown autosave remains available if browser storage is full or disabled. */ }
}

function clearCachedDraft(id: string) {
  try { localStorage.removeItem(draftKey(id)); } catch { /* ignored */ }
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = options?.body ? { "content-type": "application/json" } : undefined;
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed: ${response.status}`, response.status);
  return payload as T;
}

function formatDate(value: unknown) {
  if (typeof value !== "string") return "—";
  const timeZone = localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone }); }
  catch { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
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

function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function zonedMidnight(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guess += target - represented;
  }
  return new Date(guess);
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

function VisualMarkdownEditor({ note, markdown, readOnly, onChange }: { note: LifeObject; markdown: string; readOnly: boolean; onChange: (markdown: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const crepe = useRef<CrepeInstance | undefined>(undefined);

  useEffect(() => {
    if (!root.current) return;
    let active = true;
    let instance: CrepeInstance | undefined;
    const editorRoot = root.current;
    void import("@milkdown/crepe").then(async (crepePackage) => {
      if (!active) return;
      const Crepe = (crepePackage as unknown as { Crepe: CrepeConstructor }).Crepe;
      const uploadManagedImage = async (file: File) => {
        const stored = await api<StoredAsset>(`/api/v1/objects/${note.frontmatter.id}/assets`, { method: "POST", body: JSON.stringify({ fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64: await fileContentBase64(file) }) });
        return `/api/v1/assets/${encodeURIComponent(stored.relativePath.replace(/^assets\//, ""))}`;
      };
      instance = new Crepe({
        root: editorRoot,
        defaultValue: visualMarkdown(markdown),
        features: { "top-bar": true, latex: false, ai: false },
        featureConfigs: { "image-block": { onUpload: uploadManagedImage, inlineOnUpload: uploadManagedImage, blockOnUpload: uploadManagedImage, proxyDomURL: imagePreviewSource } }
      });
      crepe.current = instance;
      instance.on((listener) => listener.markdownUpdated((_context, nextMarkdown) => onChange(storedMarkdown(nextMarkdown, note.relativePath))));
      await instance.create();
      if (active) instance.setReadonly(readOnly);
    });
    return () => { active = false; crepe.current = undefined; if (instance) void instance.destroy(); };
  }, [note.frontmatter.id]);

  useEffect(() => { crepe.current?.setReadonly(readOnly); }, [readOnly]);
  return <div className="visual-markdown-editor" ref={root} />;
}

function ReviewCard({ review, busy, onAccept, onReject, onSave }: {
  review: LifeObject;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState(review.frontmatter.title);
  const pending = review.frontmatter.status === "pending";
  return <div className="review-card">
    {pending ? <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Proposed task title" /> : <b>{review.frontmatter.title}</b>}
    <small>{String(review.frontmatter.confidence_label)} confidence · {review.frontmatter.status}</small>
    {pending && <div className="review-actions">
      <button disabled={busy || title.trim() === review.frontmatter.title} onClick={() => onSave(title)}>Save edit</button>
      <button className="primary" disabled={busy} onClick={onAccept}>Accept task</button>
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
  const [reviews, setReviews] = useState<LifeObject[]>([]);
  const [knowledge, setKnowledge] = useState<LifeObject[]>([]);
  const [notes, setNotes] = useState<LifeObject[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string>();
  const [notesDraft, setNotesDraft] = useState("");
  const [notesBase, setNotesBase] = useState<NoteDraftBase>();
  const [notesMode, setNotesMode] = useState<"visual" | "write" | "preview">("visual");
  const [capture, setCapture] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [health, setHealth] = useState<SystemHealth>();
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [lastVerification, setLastVerification] = useState<BackupVerification>();
  const [googleConnection, setGoogleConnection] = useState<GoogleConnection>();
  const [connectionSettings, setConnectionSettings] = useState<ConnectionSettings>();
  const [objectLinks, setObjectLinks] = useState<ObjectLink[]>([]);
  const [displayTimeZone, setDisplayTimeZone] = useState(() => localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [selectedDate, setSelectedDate] = useState(() => dateInTimeZone(new Date(), localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [calendarFilter, setCalendarFilter] = useState("all");
  const [calendarSources, setCalendarSources] = useState<Record<string, { name: string; color?: string }>>({});
  const [draft, setDraft] = useState("");
  const [editorMode, setEditorMode] = useState<"visual" | "write" | "preview">("visual");
  const [busy, setBusy] = useState(false);
  const [notesAutoSaving, setNotesAutoSaving] = useState(false);
  const [meetingAutoSaving, setMeetingAutoSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("Loading local workspace…");
  const editor = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const notesEditor = useRef<HTMLTextAreaElement>(null);
  const notesImageInput = useRef<HTMLInputElement>(null);
  const activeNotesDraft = useRef("");
  const activeMeetingDraft = useRef("");
  const restoredNoteId = useRef<string | undefined>(undefined);
  const rememberedNoteId = useRef<string | undefined>(localStorage.getItem("lifeos.activeNoteId") ?? undefined);
  const dirty = Boolean(workspace?.note && draft !== workspace.note.body);
  const selectedNote = notes.find((note) => note.frontmatter.id === selectedNoteId);
  const notesDirty = Boolean(selectedNote && notesDraft !== selectedNote.body);
  const readOnly = health?.session.writeAllowed === false;

  const loadCollections = async () => {
    const [nextToday, nextTasks, nextProjects, nextReviews, nextHealth, nextBackups, nextKnowledge, nextClients, nextProducts, nextPeople, nextSettings, nextObjectLinks, nextNotes] = await Promise.all([
      api<Today>("/api/v1/today"), api<LifeObject[]>("/api/v1/tasks"),
      api<ProjectRollup[]>("/api/v1/projects"), api<LifeObject[]>("/api/v1/review-items"), api<SystemHealth>("/api/v1/health"), api<BackupSummary[]>("/api/v1/backups"), api<LifeObject[]>("/api/v1/knowledge"), api<EntityRollup[]>("/api/v1/rollups/client"), api<EntityRollup[]>("/api/v1/rollups/product"), api<EntityRollup[]>("/api/v1/rollups/person"), api<ConnectionSettings>("/api/v1/settings/connections"), api<ObjectLink[]>("/api/v1/objects"), api<LifeObject[]>("/api/v1/notes")
    ]);
    setToday(nextToday); setTasks(nextTasks); setProjects(nextProjects); setReviews(nextReviews); setHealth(nextHealth); setBackups(nextBackups); setKnowledge(nextKnowledge); setClients(nextClients); setProducts(nextProducts); setPeople(nextPeople); setConnectionSettings(nextSettings); setObjectLinks(nextObjectLinks); setNotes(nextNotes);
  };

  const refreshWorkspace = async (meetingId: string) => {
    const next = await api<Workspace>(`/api/v1/meetings/${meetingId}/workspace`);
    const cached = next.note ? readCachedDraft(next.note) : undefined;
    setWorkspace(next); setDraft(cached?.body ?? next.note?.body ?? "");
    setConflict(Boolean(cached && cached.baseHash !== next.note?.contentHash));
  };

  const loadCalendarDay = async (date = selectedDate) => {
    const range = dayRange(date, displayTimeZone);
    const nextEvents = await api<Event[]>(`/api/v1/calendar/events?${new URLSearchParams(range)}`);
    setEvents(nextEvents);
    setCalendarSources((current) => {
      const next = { ...current };
      for (const event of nextEvents) if (event.calendarId) next[event.calendarId] = { name: event.calendarName ?? event.calendarId, color: event.calendarColor };
      return next;
    });
    return nextEvents;
  };

  useEffect(() => {
    Promise.all([api<GoogleConnection>("/api/v1/connections/google").then(setGoogleConnection), loadCollections()])
      .then(async () => {
        const meetingId = localStorage.getItem("lifeos.activeMeetingId");
        if (view === "Calendar" && meetingId) await refreshWorkspace(meetingId).catch(() => localStorage.removeItem("lifeos.activeMeetingId"));
        setMessage("Local workspace ready");
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    loadCalendarDay().catch((error: Error) => { setEvents([]); setMessage(error.message); });
  }, [selectedDate, displayTimeZone]);

  useEffect(() => { localStorage.setItem("lifeos.activeView", view); }, [view]);
  useEffect(() => { activeNotesDraft.current = notesDraft; }, [notesDraft]);
  useEffect(() => { activeMeetingDraft.current = draft; }, [draft]);

  useEffect(() => {
    if (selectedNoteId || !rememberedNoteId.current) return;
    const remembered = notes.find((note) => note.frontmatter.id === rememberedNoteId.current);
    if (!remembered) return;
    const opened = openNoteDraft(remembered, readCachedDraft(remembered));
    restoredNoteId.current = remembered.frontmatter.id;
    setNotesBase(opened.base); setNotesDraft(opened.draft);
    setSelectedNoteId(remembered.frontmatter.id);
    if (opened.conflict) setConflict(true);
  }, [notes, selectedNoteId]);

  useEffect(() => {
    if (!selectedNote || restoredNoteId.current === selectedNote.frontmatter.id) return;
    restoredNoteId.current = selectedNote.frontmatter.id;
    const opened = openNoteDraft(selectedNote, readCachedDraft(selectedNote));
    setNotesBase(opened.base); setNotesDraft(opened.draft);
    if (opened.conflict) {
      setConflict(true);
      setMessage("Recovered a browser draft, but the Markdown file also changed. Review before saving.");
    }
  }, [selectedNote]);

  // A refreshed list may carry an external edit: adopt it if the draft is untouched, otherwise stop autosave.
  useEffect(() => {
    if (!selectedNote || !notesBase || notesAutoSaving) return;
    const result = reconcileNoteDraft(notesBase, notesDraft, selectedNote);
    if (result.kind === "resync") { setNotesBase(result.base); setNotesDraft(result.draft); }
    if (result.kind === "conflict" && !conflict) {
      setConflict(true);
      setMessage("This note changed on disk while you were editing. Autosave paused; your draft is kept in the browser.");
    }
  }, [selectedNote?.contentHash, notesBase?.hash, notesAutoSaving]);

  useEffect(() => {
    if (!selectedNote || restoredNoteId.current !== selectedNote.frontmatter.id) return;
    if (!notesDirty) { clearCachedDraft(selectedNote.frontmatter.id); return; }
    if (!notesBase || notesBase.noteId !== selectedNote.frontmatter.id) return;
    cacheDraft(notesBase.noteId, notesDraft, notesBase.hash);
    if (readOnly || busy || conflict || notesAutoSaving) return;
    const noteId = notesBase.noteId;
    const request = noteSaveRequest(notesBase, notesDraft);
    const bodyToSave = request.body;
    const timer = window.setTimeout(() => {
      setNotesAutoSaving(true);
      void api<LifeObject>(`/api/v1/objects/${noteId}/body`, { method: "PUT", body: JSON.stringify(request) })
        .then((updated) => {
          setNotes((current) => current.map((note) => note.frontmatter.id === noteId ? updated : note).sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at)));
          setNotesBase((current?: NoteDraftBase) => current?.noteId === noteId ? noteDraftBase(updated) : current);
          if (activeNotesDraft.current === bodyToSave) clearCachedDraft(noteId); else cacheDraft(noteId, activeNotesDraft.current, updated.contentHash);
          setMessage("Note autosaved to Markdown");
        })
        .catch((error) => {
          if (error instanceof ApiError && error.status === 409) setConflict(true);
          setMessage(`Browser draft is safe; Markdown autosave failed: ${error instanceof Error ? error.message : "unknown error"}`);
        })
        .finally(() => setNotesAutoSaving(false));
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [selectedNoteId, notesDraft, selectedNote?.contentHash, notesBase, notesDirty, readOnly, busy, conflict, notesAutoSaving]);

  useEffect(() => {
    const note = workspace?.note;
    if (!note) return;
    if (!dirty) { clearCachedDraft(note.frontmatter.id); return; }
    cacheDraft(note.frontmatter.id, draft, note.contentHash);
    if (readOnly || busy || conflict || meetingAutoSaving) return;
    const noteId = note.frontmatter.id;
    const expectedHash = note.contentHash;
    const bodyToSave = draft;
    const timer = window.setTimeout(() => {
      setMeetingAutoSaving(true);
      void api<LifeObject>(`/api/v1/objects/${noteId}/body`, { method: "PUT", body: JSON.stringify({ body: bodyToSave, expectedHash }) })
        .then((updated) => {
          setWorkspace((current) => current?.note?.frontmatter.id === noteId ? { ...current, note: updated } : current);
          if (activeMeetingDraft.current === bodyToSave) clearCachedDraft(noteId); else cacheDraft(noteId, activeMeetingDraft.current, updated.contentHash);
          setMessage("Meeting note autosaved to Markdown");
        })
        .catch((error) => {
          if (error instanceof ApiError && error.status === 409) setConflict(true);
          setMessage(`Browser draft is safe; Markdown autosave failed: ${error instanceof Error ? error.message : "unknown error"}`);
        })
        .finally(() => setMeetingAutoSaving(false));
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [workspace?.note?.frontmatter.id, workspace?.note?.contentHash, draft, dirty, readOnly, busy, conflict, meetingAutoSaving]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setConflict(false);
    try { await action(); setMessage(success); return true; }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      setMessage(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally { setBusy(false); }
  }

  const openEvent = (selectedEvent: Event) => run(async () => {
    const { externalId, calendarId } = selectedEvent;
    const range = dayRange(selectedDate, displayTimeZone);
    const next = health?.session.writeAllowed === false
      ? await api<Workspace>(`/api/v1/meetings/from-event/${encodeURIComponent(externalId)}`)
      : await api<Workspace>("/api/v1/meetings/from-event", { method: "POST", body: JSON.stringify({ externalId, calendarId, ...range }) });
    const cached = next.note ? readCachedDraft(next.note) : undefined;
    setWorkspace(next); setDraft(cached?.body ?? next.note?.body ?? ""); setEditorMode("visual");
    setEvents((current) => current.map((event) => event.externalId === externalId && event.calendarId === calendarId
      ? { ...event, hasNote: Boolean(next.note), meetingId: next.meeting.frontmatter.id, noteId: next.note?.frontmatter.id }
      : event));
    localStorage.setItem("lifeos.activeMeetingId", next.meeting.frontmatter.id);
    if (cached?.baseHash !== undefined && cached.baseHash !== next.note?.contentHash) setConflict(true);
    await loadCollections();
  }, "Canonical meeting note ready");

  const saveNote = () => run(async () => {
    if (!workspace?.note) return;
    await api(`/api/v1/objects/${workspace.note.frontmatter.id}/body`, { method: "PUT", body: JSON.stringify({ body: draft, expectedHash: workspace.note.contentHash }) });
    clearCachedDraft(workspace.note.frontmatter.id);
    await refreshWorkspace(workspace.meeting.frontmatter.id);
  }, "Note saved to Markdown");

  const processMeeting = () => run(async () => {
    if (!workspace) return;
    if (dirty) {
      await api(`/api/v1/objects/${workspace.note!.frontmatter.id}/body`, { method: "PUT", body: JSON.stringify({ body: draft, expectedHash: workspace.note!.contentHash }) });
    }
    await api(`/api/v1/meetings/${workspace.meeting.frontmatter.id}/process`, { method: "POST" });
    await refreshWorkspace(workspace.meeting.frontmatter.id); await loadCollections();
  }, "Mock AI proposal created");

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

  const editReview = (reviewId: string, title: string) => run(async () => {
    await api(`/api/v1/review-items/${reviewId}`, { method: "PATCH", body: JSON.stringify({ title }) });
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
    setEvents(await api<Event[]>(`/api/v1/calendar/sync?${new URLSearchParams(range)}`, { method: "POST" }));
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
    const selected = draft.slice(start, end) || placeholder;
    const next = `${draft.slice(0, start)}${before}${selected}${after}${draft.slice(end)}`;
    setDraft(next);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  function insertAtCursor(content: string, selectFrom = 0, selectLength = 0) {
    const area = editor.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    setDraft(`${draft.slice(0, start)}${content}${draft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + selectFrom, start + selectFrom + selectLength); });
  }

  function transformLines(transform: (line: string, index: number) => string, placeholder = "List item") {
    const area = editor.current;
    if (!area) return;
    const selectionStart = area.selectionStart;
    const selectionEnd = area.selectionEnd;
    const start = draft.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const nextBreak = draft.indexOf("\n", selectionEnd);
    const end = nextBreak === -1 ? draft.length : nextBreak;
    const source = draft.slice(start, end) || placeholder;
    const replacement = source.split("\n").map(transform).join("\n");
    setDraft(`${draft.slice(0, start)}${replacement}${draft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start, start + replacement.length); });
  }

  function applyHeading(level: string) {
    if (!level) return;
    transformLines((line) => `${"#".repeat(Number(level))} ${line.replace(/^#{1,6}\s+/, "")}`, "Heading");
  }

  function insertCodeBlock() {
    const language = window.prompt("Code language (for example: typescript, python, sql)", "typescript");
    if (language === null) return;
    const selected = editor.current ? draft.slice(editor.current.selectionStart, editor.current.selectionEnd) : "";
    insertMarkdown(`\n\n\`\`\`${language.trim()}\n`, "\n\`\`\`\n\n", selected || "code");
  }

  async function uploadImage(file: File) {
    if (!workspace?.note || !file.type.startsWith("image/")) return;
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
      const stored = await api<StoredAsset>(`/api/v1/objects/${workspace.note.frontmatter.id}/assets`, { method: "POST", body: JSON.stringify({ fileName: file.name || "pasted-screenshot.png", mimeType: file.type, contentBase64 }) });
      const markdown = `![${altText.trim()}](${stored.markdownPath})`;
      setDraft(`${draft.slice(0, insertionStart)}${markdown}${draft.slice(insertionEnd)}`);
      requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(insertionStart + markdown.length, insertionStart + markdown.length); });
      setMessage(stored.deduplicated ? "Existing image reused; Markdown link inserted" : "Image stored locally; Markdown link inserted");
      await loadCollections();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Image upload failed");
    } finally { setBusy(false); }
  }

  function openNote(note: LifeObject) {
    const opened = openNoteDraft(note, readCachedDraft(note));
    restoredNoteId.current = note.frontmatter.id;
    setSelectedNoteId(note.frontmatter.id); setNotesBase(opened.base); setNotesDraft(opened.draft); setNotesMode("visual");
    localStorage.setItem("lifeos.activeNoteId", note.frontmatter.id);
    setConflict(opened.conflict);
  }

  const saveSelectedNote = () => run(async () => {
    if (!selectedNote || notesBase?.noteId !== selectedNote.frontmatter.id) return;
    const updated = await api<LifeObject>(`/api/v1/objects/${selectedNote.frontmatter.id}/body`, { method: "PUT", body: JSON.stringify(noteSaveRequest(notesBase, notesDraft)) });
    setNotes((current) => current.map((note) => note.frontmatter.id === updated.frontmatter.id ? updated : note).sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at)));
    setNotesBase(noteDraftBase(updated)); setNotesDraft(updated.body);
    clearCachedDraft(updated.frontmatter.id);
    await loadCollections();
  }, "Note saved to Markdown");

  function editNotes(before: string, after = "", placeholder = "text") {
    const area = notesEditor.current;
    if (!area) return;
    const start = area.selectionStart; const end = area.selectionEnd;
    const selected = notesDraft.slice(start, end) || placeholder;
    setNotesDraft(`${notesDraft.slice(0, start)}${before}${selected}${after}${notesDraft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  function insertNotes(content: string) {
    const area = notesEditor.current;
    if (!area) return;
    const start = area.selectionStart; const end = area.selectionEnd;
    setNotesDraft(`${notesDraft.slice(0, start)}${content}${notesDraft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start + content.length, start + content.length); });
  }

  function transformNoteLines(transform: (line: string, index: number) => string, placeholder = "List item") {
    const area = notesEditor.current;
    if (!area) return;
    const selectionStart = area.selectionStart; const selectionEnd = area.selectionEnd;
    const start = notesDraft.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const nextBreak = notesDraft.indexOf("\n", selectionEnd); const end = nextBreak === -1 ? notesDraft.length : nextBreak;
    const replacement = (notesDraft.slice(start, end) || placeholder).split("\n").map(transform).join("\n");
    setNotesDraft(`${notesDraft.slice(0, start)}${replacement}${notesDraft.slice(end)}`);
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(start, start + replacement.length); });
  }

  async function uploadNotesImage(file: File) {
    if (!selectedNote || !file.type.startsWith("image/")) return;
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
      setNotesDraft(`${notesDraft.slice(0, start)}${markdown}${notesDraft.slice(end)}`);
      setMessage(stored.deduplicated ? "Existing image reused; Markdown link inserted" : "Image stored locally; Markdown link inserted");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Image upload failed"); }
    finally { setBusy(false); }
  }

  async function reloadSelectedNote() {
    if (!selectedNoteId) return;
    const refreshed = await api<LifeObject[]>("/api/v1/notes");
    setNotes(refreshed);
    const note = refreshed.find((candidate) => candidate.frontmatter.id === selectedNoteId);
    if (note) { setNotesBase(noteDraftBase(note)); setNotesDraft(note.body); clearCachedDraft(note.frontmatter.id); }
    setConflict(false); setMessage("Reloaded the latest Markdown from disk");
  }

  const navigation: View[] = ["Today", "Calendar", "Notes", "Tasks", "Projects", "Clients", "Products", "People", "Knowledge", "Inbox", "System"];
  const pendingReviews = reviews.filter((review) => review.frontmatter.status === "pending");
  const filteredEvents = events
    .filter((event) => calendarFilter === "all" || event.calendarId === calendarFilter)
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const allDayEvents = filteredEvents.filter((event) => event.isAllDay);
  const timedEvents = filteredEvents.filter((event) => !event.isAllDay);

  return <main>
    <aside>
      <h1>LifeOS</h1>
      {navigation.map((item) => <button className={item === view ? "active" : ""} key={item} onClick={() => setView(item)}>{item}{item === "Inbox" && pendingReviews.length > 0 ? <em>{pendingReviews.length}</em> : null}</button>)}
      <button className={`settings-link ${view === "Settings" ? "active" : ""}`} onClick={() => setView("Settings")}>Settings</button>
      <p className="connection"><i className={readOnly ? "warning-dot" : ""} /> {readOnly ? "Read-only · another device active" : message}</p>
    </aside>

    <section>
      {view === "Today" && <>
        <PageHeader eyebrow="HOME / TODAY" title="What needs your attention?" description="A calm view of active work and pending decisions." />
        <div className="summary">
          <Summary label="Active tasks" value={today.tasks.length} detail="across all contexts" />
          <Summary label="Review inbox" value={today.reviewCount} detail="awaiting confirmation" />
          <Summary label="Today's events" value={events.length} detail="across connected calendars" />
        </div>
        <article className="quick-capture"><span>QUICK CAPTURE</span><div className="capture-row"><input value={capture} onChange={(event) => setCapture(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && capture.trim()) submitCapture(); }} placeholder="Capture a task or commitment…" /><button className="primary" disabled={!capture.trim() || busy || readOnly} onClick={submitCapture}>Capture</button></div></article>
        <article><span>SUGGESTED TOP 3</span>{!today.topThree.length && <p className="muted">No active commitments to rank.</p>}{today.topThree.map(({ task, reason }) => <div className="object-row" key={task.frontmatter.id}><i /><div><b>{task.frontmatter.title}</b><small>{reason}</small></div></div>)}</article>
        <ObjectList title="Overdue" objects={today.overdue} empty="Nothing overdue." />
        <ObjectList title="Due today" objects={today.dueToday} empty="Nothing due today." />
        <ObjectList title="Upcoming priority work" objects={today.upcoming.length ? today.upcoming : today.tasks.filter((task) => task.frontmatter.priority === "High")} empty="No upcoming dated or high-priority work." />
        <ObjectList title="Waiting" objects={today.waiting} empty="Nothing waiting on someone else." />
        <article><span>TODAY'S EVENTS</span>{!events.length && <p className="muted">No events today.</p>}{events.slice(0, 5).map((event) => <div className="object-row" key={`${event.calendarId ?? "calendar"}:${event.externalId}`}><i /><div><b>{event.title}</b><small>{formatEventDate(event)} · {event.calendarName ?? "Calendar"}</small></div></div>)}</article>
      </>}

      {view === "Calendar" && <>
        <PageHeader eyebrow="CALENDAR / MEETING" title="Meeting workspace" description="Capture in Markdown, review proposed commitments, and publish only what you confirm." />
        {googleConnection && !googleConnection.connected && <article className="lease-warning"><span>GOOGLE CALENDAR</span><h3>{googleConnection.configured ? "Ready to connect" : "Configuration required"}</h3><p>{googleConnection.configured ? "Authorize read-only access to replace the mock calendar with your upcoming events." : "Add the Google Calendar OAuth client under Settings, then return here to connect."}</p>{googleConnection.configured ? <button className="takeover" disabled={busy} onClick={connectGoogle}>Connect Google Calendar</button> : <button onClick={() => setView("Settings")}>Open Settings</button>}</article>}
        {googleConnection?.connected && <article className="connection-card"><span>GOOGLE CALENDAR CONNECTED</span><p className="muted">Read-only access is active. Each manual sync records a durable Sync Run.</p><button disabled={busy || readOnly} onClick={syncGoogle}>Sync now</button></article>}
        <div className="meeting-layout">
          <article className="event-list">
            <div className="event-list-heading"><span>DAY TIMELINE</span><button onClick={() => setSelectedDate(dateInTimeZone(new Date(), displayTimeZone))}>Today</button></div>
            <div className="calendar-controls">
              <label><small>Date</small><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
              <label><small>Calendar</small><select value={calendarFilter} onChange={(event) => setCalendarFilter(event.target.value)}>
                <option value="all">All calendars</option>
                {Object.entries(calendarSources).sort(([, left], [, right]) => left.name.localeCompare(right.name)).map(([id, source]) => <option value={id} key={id}>{source.name}</option>)}
              </select></label>
            </div>
            <h3 className="timeline-date">{new Date(`${selectedDate}T12:00:00.000Z`).toLocaleDateString([], { dateStyle: "full", timeZone: displayTimeZone })}</h3>
            {!filteredEvents.length && <div className="timeline-empty"><b>No events</b><small>This calendar is clear for the selected day.</small></div>}
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
          <div className="meeting-main">
            {!workspace ? <article className="empty-state"><h3>Select a meeting</h3><p>Open an event to create or resume its canonical note.</p></article> : <>
              <article className="meeting-header">
                <div><span>MEETING</span><h3>{workspace.meeting.frontmatter.title}</h3></div>
                <div className="context-grid">
                  <Meta label="When" value={workspace.meeting.frontmatter.is_all_day === true ? `${String(workspace.meeting.frontmatter.starts_at).slice(0, 10)} · All day` : formatDate(workspace.meeting.frontmatter.starts_at)} />
                  <Meta label="Project" value={workspace.context.project?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Client" value={workspace.context.client?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Product" value={workspace.context.product?.frontmatter.title ?? "Not linked"} />
                  <Meta label="Attendees" value={workspace.context.people.map((person) => person.frontmatter.title).join(", ") || "None"} />
                </div>
              </article>
              <article className="editor-card">
                <div className="editor-heading">
                  <div><span>CANONICAL NOTE</span><h3>{workspace.note?.frontmatter.title}</h3></div>
                  <div className="mode-switch"><button className={editorMode === "visual" ? "selected" : ""} onClick={() => setEditorMode("visual")}>Visual</button><button className={editorMode === "write" ? "selected" : ""} onClick={() => setEditorMode("write")}>Markdown</button><button className={editorMode === "preview" ? "selected" : ""} onClick={() => setEditorMode("preview")}>Preview</button></div>
                </div>
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
                  <textarea ref={editor} disabled={!workspace.note || busy || readOnly} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => { const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadImage(file); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadImage(file); } }} placeholder="Capture meeting notes… Paste or drop an image here." />
                </> : editorMode === "visual" && workspace.note ? <VisualMarkdownEditor note={workspace.note} markdown={draft} readOnly={busy || readOnly} onChange={setDraft} /> : <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{draft || "_Nothing to preview yet._"}</ReactMarkdown></div>}
                <div className="editor-footer">
                  <div className="save-state"><i className={dirty ? "dirty" : "saved"} />{dirty ? meetingAutoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}</div>
                  <div className="actions"><button disabled={!workspace.note || busy || !dirty || readOnly} onClick={saveNote}>Save Markdown</button><button className="primary" disabled={!workspace.note || busy || !draft.trim() || readOnly} onClick={processMeeting}>Save & process</button></div>
                </div>
                {conflict && <div className="conflict"><b>This note changed on disk.</b><span>Your browser draft was not overwritten.</span><button onClick={() => { if (workspace.note) clearCachedDraft(workspace.note.frontmatter.id); void refreshWorkspace(workspace.meeting.frontmatter.id); }}>Discard draft & reload disk</button></div>}
                {workspace.note && <div className="metadata-strip"><Meta label="Created" value={formatDate(workspace.note.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(workspace.note.frontmatter.updated_at)} /><Meta label="Revision" value={String(workspace.note.frontmatter.revision)} /><Meta label="File" value={workspace.note.relativePath} /></div>}
              </article>
              <article><span>REVIEW BEFORE PUBLISHING</span><h3>Meeting proposals</h3>
                {!workspace.reviews.length && <p className="muted">Process the note to create a durable review item.</p>}
                {workspace.reviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review.frontmatter.id)} onReject={() => reject(review.frontmatter.id)} onSave={(title) => editReview(review.frontmatter.id, title)} />)}
              </article>
            </>}
          </div>
        </div>
      </>}

      {view === "Notes" && <>
        <PageHeader eyebrow="NOTES" title="Recent notes" description="Open the latest meeting and knowledge notes, edit the Markdown, and save changes back to the portable repository." />
        <div className="notes-layout">
          <article className="notes-list">
            <div className="notes-list-heading"><span>LATEST NOTES</span><small>{notes.length} total</small></div>
            {!notes.length && <p className="muted">No notes have been created yet.</p>}
            {notes.map((note) => <button className={note.frontmatter.id === selectedNoteId ? "note-list-item selected" : "note-list-item"} key={note.frontmatter.id} onClick={() => openNote(note)}>
              <b>{note.frontmatter.title}</b><small>{note.frontmatter.type === "meeting-note" ? "Meeting note" : "Knowledge note"} · {formatDate(note.frontmatter.updated_at)}</small><span>{note.body.replace(/[#>*_`\[\]-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110) || "Empty note"}</span>
            </button>)}
          </article>
          <div className="notes-main">
            {!selectedNote ? <article className="empty-state"><h3>Select a note</h3><p>Choose a recent note to view or edit its Markdown.</p></article> : <article className="editor-card">
              <div className="editor-heading"><div><span>{selectedNote.frontmatter.type.replace("-", " ").toUpperCase()}</span><h3>{selectedNote.frontmatter.title}</h3></div><div className="mode-switch"><button className={notesMode === "visual" ? "selected" : ""} onClick={() => setNotesMode("visual")}>Visual</button><button className={notesMode === "write" ? "selected" : ""} onClick={() => setNotesMode("write")}>Markdown</button><button className={notesMode === "preview" ? "selected" : ""} onClick={() => setNotesMode("preview")}>Preview</button></div></div>
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
                <textarea ref={notesEditor} disabled={busy || readOnly} value={notesDraft} onChange={(event) => setNotesDraft(event.target.value)} onPaste={(event) => { const file = Array.from(event.clipboardData.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadNotesImage(file); } }} placeholder="Write Markdown… Paste or drop an image here." />
              </> : notesMode === "visual" ? <VisualMarkdownEditor note={selectedNote} markdown={notesDraft} readOnly={busy || readOnly} onChange={setNotesDraft} /> : <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt, ...props }) => <img {...props} src={imagePreviewSource(src)} alt={alt ?? ""} /> }}>{notesDraft || "_Nothing to preview yet._"}</ReactMarkdown></div>}
              <div className="editor-footer"><div className="save-state"><i className={notesDirty ? "dirty" : "saved"} />{notesDirty ? notesAutoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending" : "Saved to Markdown"}</div><div className="actions"><button className="primary" disabled={busy || readOnly || !notesDirty} onClick={saveSelectedNote}>Save now</button></div></div>
              {conflict && <div className="conflict"><b>This note changed on disk.</b><span>Your draft was not overwritten.</span><button onClick={reloadSelectedNote}>Reload disk version</button></div>}
              <div className="metadata-strip"><Meta label="Created" value={formatDate(selectedNote.frontmatter.created_at)} /><Meta label="Updated" value={formatDate(selectedNote.frontmatter.updated_at)} /><Meta label="Revision" value={String(selectedNote.frontmatter.revision)} /><Meta label="File" value={selectedNote.relativePath} /></div>
            </article>}
          </div>
        </div>
      </>}

      {view === "Tasks" && <EntityCrudPage type="task" title="Tasks" objects={tasks} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}

      {view === "Projects" && <><PageHeader eyebrow="PROJECTS" title="Project roll-ups" description="Meetings and tasks are computed from stable relationships, not copied lists." />
        <EntityCrudPage embedded type="project" title="Projects" objects={projects.map(({ project }) => project)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />
        <div className="project-grid">{projects.map(({ project, tasks: projectTasks, meetings, decisions, openPoints, people: projectPeople }) => <article key={project.frontmatter.id}><span>PROJECT</span><h3>{project.frontmatter.title}</h3><p className="muted">{String(project.frontmatter.objective ?? "No objective")}</p><div className="project-stats"><b>{projectTasks.length}<small>tasks</small></b><b>{openPoints.length}<small>open points</small></b><b>{decisions.length}<small>decisions</small></b><b>{meetings.length}<small>meetings</small></b></div><p className="muted">People: {projectPeople.map((person) => person.frontmatter.title).join(", ") || "None linked"}</p></article>)}</div>
        {!projects.length && <article className="empty-state"><h3>No projects yet</h3><p>Opening the mock calendar event will create its linked project context.</p></article>}
      </>}

      {view === "Clients" && <EntityCrudPage type="client" title="Clients" objects={clients.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}
      {view === "Products" && <EntityCrudPage type="product" title="Products" objects={products.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}
      {view === "People" && <EntityCrudPage type="person" title="People" objects={people.map(({ entity }) => entity)} people={people.map(({ entity }) => entity)} busy={busy} readOnly={readOnly} onCreate={createEntity} onUpdate={updateEntity} onDelete={deleteEntity} />}

      {view === "Inbox" && <><PageHeader eyebrow="INBOX" title="Review proposals" description="Nothing becomes a commitment until you accept it." />
        {!pendingReviews.length && <article className="empty-state"><h3>Inbox clear</h3><p>No proposals require your attention.</p></article>}
        {pendingReviews.map((review) => <ReviewCard key={review.frontmatter.id} review={review} busy={busy || readOnly} onAccept={() => accept(review.frontmatter.id)} onReject={() => reject(review.frontmatter.id)} onSave={(title) => editReview(review.frontmatter.id, title)} />)}
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

      {view === "Settings" && <><PageHeader eyebrow="SETTINGS / CONNECTIONS" title="Connections and preferences" description="Credentials are write-only from this screen and stored in macOS Keychain, never Markdown or Git." /><article className="timezone-setting"><span>DISPLAY TIMEZONE</span><h3>{displayTimeZone}</h3><p className="muted">Timestamps remain portable UTC instants. LifeOS displays them in this device-specific IANA timezone, including daylight-saving changes.</p><select value={displayTimeZone} onChange={(event) => { localStorage.setItem("lifeos.displayTimeZone", event.target.value); setDisplayTimeZone(event.target.value); }}>{availableTimeZones.map((zone) => <option key={zone}>{zone}</option>)}</select></article><div className="settings-grid"><GoogleSecretCard provider="calendar" title="Google Calendar" status={connectionSettings?.calendar} busy={busy || readOnly} onSave={saveGoogleSecrets} /><GoogleSecretCard provider="drive" title="Google Drive" status={connectionSettings?.drive} busy={busy || readOnly} onSave={saveGoogleSecrets} /></div><article><span>SECURITY</span><p className="muted">LifeOS only reports whether credentials exist. Saved client secrets cannot be read back through the API or UI. Calendar authorization happens from the Calendar page after its credentials are configured.</p></article></>}
    </section>
  </main>;
}

function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p className="lede">{description}</p></header>;
}
function Summary({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta"><small>{label}</small><b title={value}>{value}</b></div>;
}
function ObjectList({ title, objects, empty }: { title: string; objects: LifeObject[]; empty: string }) {
  return <article><span>{title.toUpperCase()}</span>{!objects.length && <p className="muted">{empty}</p>}{objects.map((object) => <div className="object-row" key={object.frontmatter.id}><i /><div><b>{object.frontmatter.title}</b><small>{object.frontmatter.status ?? object.frontmatter.type} · Updated {formatDate(object.frontmatter.updated_at)}</small></div></div>)}</article>;
}

const entityFields: Record<EntityType, Array<{ key: string; label: string; kind?: "select" | "date" | "person"; options?: string[] }>> = {
  task: [{ key: "status", label: "Status", kind: "select", options: ["Inbox", "Next", "Waiting", "Done", "Cancelled"] }, { key: "priority", label: "Priority", kind: "select", options: ["", "High", "Medium", "Low"] }, { key: "owner_person_id", label: "Owner", kind: "person" }, { key: "waiting_for_person_id", label: "Waiting for", kind: "person" }, { key: "due_on", label: "Due date", kind: "date" }, { key: "expected_output", label: "Expected output" }],
  project: [{ key: "status", label: "Status" }, { key: "objective", label: "Objective" }, { key: "success_criteria", label: "Success criteria" }, { key: "owner_person_id", label: "Owner", kind: "person" }, { key: "target_end_on", label: "Target end", kind: "date" }],
  client: [{ key: "status", label: "Status" }, { key: "summary", label: "Summary" }, { key: "website_url", label: "Website" }, { key: "primary_contact_person_id", label: "Primary contact", kind: "person" }],
  product: [{ key: "status", label: "Status" }, { key: "description", label: "Description" }, { key: "owner_person_id", label: "Owner", kind: "person" }],
  person: [{ key: "given_name", label: "Given name" }, { key: "family_name", label: "Family name" }, { key: "organization_name", label: "Organization" }, { key: "job_title", label: "Job title" }, { key: "timezone", label: "Timezone" }]
};

function EntityCrudPage({ type, title, objects, people, busy, readOnly, embedded = false, onCreate, onUpdate, onDelete }: { type: EntityType; title: string; objects: LifeObject[]; people: LifeObject[]; busy: boolean; readOnly: boolean; embedded?: boolean; onCreate: (type: EntityType, fields: Record<string, unknown>) => void; onUpdate: (object: LifeObject, fields: Record<string, unknown>) => void; onDelete: (object: LifeObject) => void }) {
  const [newTitle, setNewTitle] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => setDrafts(Object.fromEntries(objects.map((object) => [object.frontmatter.id, { ...object.frontmatter }]))), [objects]);
  const setField = (id: string, key: string, value: unknown) => setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  const create = () => { onCreate(type, { title: newTitle }); setNewTitle(""); };
  return <>{!embedded && <PageHeader eyebrow={type.toUpperCase()} title={title} description={`Create, inspect, edit, archive through history, and soft-delete ${title.toLowerCase()} stored as typed Markdown.`} />}<article className="crud-panel"><span>{embedded ? "MANAGE PROJECTS" : `MANAGE ${title.toUpperCase()}`}</span><div className="capture-row"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTitle.trim()) create(); }} placeholder={`New ${type} title`} /><button className="primary" disabled={busy || readOnly || !newTitle.trim()} onClick={create}>Create</button></div>{!objects.length && <p className="muted">No {title.toLowerCase()} yet.</p>}<div className="crud-list">{objects.map((object) => { const draft = drafts[object.frontmatter.id] ?? object.frontmatter; return <div className="crud-card" key={object.frontmatter.id}><div className="crud-fields"><label><small>Title</small><input value={String(draft.title ?? "")} onChange={(event) => setField(object.frontmatter.id, "title", event.target.value)} /></label>{entityFields[type].map((field) => <label key={field.key}><small>{field.label}</small>{field.kind === "select" ? <select value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)}>{field.options!.map((option) => <option value={option} key={option}>{option || "None"}</option>)}</select> : field.kind === "person" ? <select value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)}><option value="">None</option>{people.map((person) => <option value={person.frontmatter.id} key={person.frontmatter.id}>{person.frontmatter.title}</option>)}</select> : <input type={field.kind === "date" ? "date" : "text"} value={String(draft[field.key] ?? "")} onChange={(event) => setField(object.frontmatter.id, field.key, event.target.value || undefined)} />}</label>)}</div><div className="crud-actions"><small>Revision {object.frontmatter.revision} · {formatDate(object.frontmatter.updated_at)}</small><button disabled={busy || readOnly} onClick={() => onUpdate(object, draft)}>Save changes</button><button className="danger" disabled={busy || readOnly || object.frontmatter.is_self === true} onClick={() => { if (window.confirm(`Soft-delete ${object.frontmatter.title}? The Markdown file will be retained.`)) onDelete(object); }}>Delete</button></div></div>; })}</div></article></>;
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
