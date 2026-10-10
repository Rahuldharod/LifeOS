// The workspace's lists: Today, tasks, projects, reviews, notes, people and the rest, plus the
// separately loaded Connections, Enrichment and Today panels. App reads the values and calls
// `refresh()` after every change; nothing else fetches or holds these lists. `refresh` rejects when a
// main list fails; Connections, Enrichment and Today panels load on their own and never fail it or
// each other, and person labels fall back to `[]`. `call` is the API seam (tests pass a fake).
import { useState } from "react";
import type { AppliedPatch, BackupSummary, EnrichmentStatus, EntityRollup, InboxStatus, LifeObject, ObjectLink, PersonLabel, ProjectRollup, ReviewEvidence, SystemHealth, Today, TodayPanels } from "@lifeos/contracts";
import { api, type Api } from "./api.js";
import { loadConnections, type ConnectionsState } from "./connections.js";
import { dateInTimeZone } from "./zonedTime.js";

export type ReviewObject = LifeObject & { evidence?: Record<string, ReviewEvidence[]> };

export type WorkspaceData = {
  today: Today;
  todayPanels: TodayPanels | undefined;
  tasks: LifeObject[];
  projects: ProjectRollup[];
  reviews: ReviewObject[];
  health: SystemHealth | undefined;
  backups: BackupSummary[];
  knowledge: LifeObject[];
  clients: EntityRollup[];
  products: EntityRollup[];
  people: EntityRollup[];
  objectLinks: ObjectLink[];
  notes: LifeObject[];
  deletedNotes: LifeObject[];
  inboxDrafts: InboxStatus;
  appliedPatches: AppliedPatch[];
  /** #39: short, unambiguous names; `[]` when they could not be loaded (badges show full titles). */
  personLabels: PersonLabel[];
  enrichment: EnrichmentStatus;
  connections: ConnectionsState | undefined;
  /** Reloads every list. Rejects when a main list fails; the three separate loads never reject it. */
  refresh: () => Promise<void>;
  /** #48: reloads only the Today panels. Never rejects. */
  refreshTodayPanels: () => Promise<void>;
  /** #77: reloads the Connections card; `retry` reads the Keychain again (macOS may prompt once more). */
  refreshConnections: (options?: { retry?: boolean }) => Promise<void>;
  /** Fetches the open notes fresh, stores and returns them. */
  refreshNotes: () => Promise<LifeObject[]>;
  /** Fetches open and deleted notes fresh, stores and returns both. */
  refreshNoteLists: () => Promise<{ open: LifeObject[]; deleted: LifeObject[] }>;
  /** Fetches the object list fresh, stores and returns it (a link to something just created must resolve). */
  refreshObjectLinks: () => Promise<ObjectLink[]>;
  /** Patch in place: a note was saved. */
  updateNotes: (change: (current: LifeObject[]) => LifeObject[]) => void;
  /** Patch in place: the focus changed. */
  updateToday: (change: (current: Today) => Today) => void;
  /** Patch in place: the write-lease answer from the activity heartbeat. */
  updateHealth: (change: (current: SystemHealth | undefined) => SystemHealth | undefined) => void;
};

export function useWorkspaceData({ displayTimeZone, call = api }: { displayTimeZone: string; call?: Api }): WorkspaceData {
  const [today, setToday] = useState<Today>({ tasks: [], overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 0 });
  const [todayPanels, setTodayPanels] = useState<TodayPanels>();
  const [tasks, setTasks] = useState<LifeObject[]>([]);
  const [projects, setProjects] = useState<ProjectRollup[]>([]);
  const [clients, setClients] = useState<EntityRollup[]>([]);
  const [products, setProducts] = useState<EntityRollup[]>([]);
  const [people, setPeople] = useState<EntityRollup[]>([]);
  const [personLabels, setPersonLabels] = useState<PersonLabel[]>([]);
  const [reviews, setReviews] = useState<ReviewObject[]>([]);
  const [knowledge, setKnowledge] = useState<LifeObject[]>([]);
  const [notes, setNotes] = useState<LifeObject[]>([]);
  const [deletedNotes, setDeletedNotes] = useState<LifeObject[]>([]);
  const [health, setHealth] = useState<SystemHealth>();
  const [inboxDrafts, setInboxDrafts] = useState<InboxStatus>({ awaiting: 0, drafts: 0, patches: 0, failed: [] });
  const [enrichment, setEnrichment] = useState<EnrichmentStatus>({ proposedGaveUp: [], staleWorkOrders: [] });
  const [appliedPatches, setAppliedPatches] = useState<AppliedPatch[]>([]);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionsState>();
  const [objectLinks, setObjectLinks] = useState<ObjectLink[]>([]);

  const refreshTodayPanels = () => call("GET /api/v1/today/panels", { query: { date: dateInTimeZone(new Date(), displayTimeZone), timeZone: displayTimeZone } }).then(setTodayPanels).catch(() => undefined);

  const refreshConnections = async ({ retry = false }: { retry?: boolean } = {}) => {
    setConnections(await loadConnections(() => retry ? call("POST /api/v1/settings/connections/retry") : call("GET /api/v1/settings/connections"), connections?.settings));
  };

  const refresh = async () => {
    // Without labels, badges fall back to full titles rather than failing the whole load.
    const labelsRequest = call("GET /api/v1/people/labels").catch(() => [] as PersonLabel[]);
    const [nextToday, nextTasks, nextProjects, nextReviews, nextHealth, nextBackups, nextKnowledge, nextClients, nextProducts, nextPeople, nextObjectLinks, nextNotes, nextDeletedNotes, nextInboxDrafts] = await Promise.all([
      call("GET /api/v1/today", { query: { date: dateInTimeZone(new Date(), displayTimeZone) } }), call("GET /api/v1/tasks"),
      call("GET /api/v1/projects"), call("GET /api/v1/review-items"), call("GET /api/v1/health"), call("GET /api/v1/backups"), call("GET /api/v1/knowledge"), call("GET /api/v1/rollups/:type", { params: { type: "client" } }), call("GET /api/v1/rollups/:type", { params: { type: "product" } }), call("GET /api/v1/rollups/:type", { params: { type: "person" } }), call("GET /api/v1/objects"), call("GET /api/v1/notes"), call("GET /api/v1/notes", { query: { state: "deleted" } }), call("GET /api/v1/inbox/drafts")
    ]);
    setToday(nextToday); setTasks(nextTasks); setProjects(nextProjects); setReviews(nextReviews); setHealth(nextHealth); setBackups(nextBackups); setKnowledge(nextKnowledge); setClients(nextClients); setProducts(nextProducts); setPeople(nextPeople); setObjectLinks(nextObjectLinks); setNotes(nextNotes); setDeletedNotes(nextDeletedNotes); setInboxDrafts(nextInboxDrafts);
    setAppliedPatches(await call("GET /api/v1/inbox/patches"));
    // #77: loaded on its own; a Keychain problem only shows on the Connections card, never fails a load or a save.
    void refreshConnections();
    // #44: loaded on its own so a failure here never blanks the other panels.
    void call("GET /api/v1/enrichment").then(setEnrichment).catch(() => undefined);
    // #48: likewise; it may wait on the calendar, so it never holds up the rest of the page.
    void refreshTodayPanels();
    setPersonLabels(await labelsRequest);
  };

  const refreshNotes = async () => { const open = await call("GET /api/v1/notes"); setNotes(open); return open; };
  const refreshNoteLists = async () => {
    const [open, deleted] = await Promise.all([call("GET /api/v1/notes"), call("GET /api/v1/notes", { query: { state: "deleted" } })]);
    setNotes(open); setDeletedNotes(deleted);
    return { open, deleted };
  };
  const refreshObjectLinks = async () => { const objects = await call("GET /api/v1/objects"); setObjectLinks(objects); return objects; };

  return {
    today, todayPanels, tasks, projects, reviews, health, backups, knowledge, clients, products, people, objectLinks, notes, deletedNotes, inboxDrafts, appliedPatches, personLabels, enrichment, connections,
    refresh, refreshTodayPanels, refreshConnections, refreshNotes, refreshNoteLists, refreshObjectLinks,
    updateNotes: setNotes, updateToday: setToday, updateHealth: setHealth
  };
}
