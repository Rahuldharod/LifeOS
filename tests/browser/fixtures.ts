// #154: synthetic data for browser tests, created through the real localhost API (prefix /api/v1).
// Knowledge notes and Inbox proposals come from Inbox Drafts that serve.mjs writes into the temporary data root;
// seed() asks the server to adopt them. Everything here is synthetic (example.com style).
import type { APIRequestContext } from "@playwright/test";
import { routePath, type View } from "../../apps/web/src/routes.js";

export type Seeded = { id: string; title: string };
export const RECURRING_NOTE = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Weekly planning notes",
  currentSectionId: "occurrence-2026-10-12t08-00-00-000z",
  olderSectionId: "occurrence-2026-10-05t08-00-00-000z"
} as const;
export type SeedData = {
  tasks: Seeded[];
  /** The task with a very long title. */
  longTitleTask: Seeded;
  projects: Seeded[];
  people: Seeded[];
  decisions: Seeded[];
  openPoints: Seeded[];
  /** Knowledge notes; `longKnowledgeNote` has a long multi-paragraph body. */
  knowledgeNotes: Seeded[];
  longKnowledgeNote: Seeded;
  /** Pending Inbox review proposals (Review Item ids and the proposed titles). */
  reviewItems: Seeded[];
  recurringNote: Seeded;
};

/** The path of a record's direct link, e.g. `recordUrl("Tasks", id)` is `/tasks/<id>`. Mirrors apps/web/src/routes.ts. */
export function recordUrl(view: View, id?: string): string {
  return routePath({ view, ...(id ? { id } : {}) });
}

export const LONG_TASK_TITLE = "Prepare the quarterly alignment review for the example.com platform migration including budget, staffing, risks, dependencies, vendor contracts and the communication plan for every affected team";

type Obj = { frontmatter: { id: string; title: string } };
const pick = (object: Obj): Seeded => ({ id: object.frontmatter.id, title: object.frontmatter.title });

async function api<T>(request: APIRequestContext, method: "GET" | "POST", url: string, data?: unknown): Promise<T> {
  const response = await request.fetch(url, { method, ...(data === undefined ? {} : { data }) });
  if (!response.ok()) throw new Error(`${method} ${url} failed: ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

let seeded: Promise<SeedData> | undefined;

/** Seeds once per server run (idempotent: later calls, and a re-run against a seeded server, return the same data). */
export function seed(request: APIRequestContext): Promise<SeedData> {
  seeded ??= seedOnce(request).catch((error) => { seeded = undefined; throw error; });
  return seeded;
}

async function seedOnce(request: APIRequestContext): Promise<SeedData> {
  const post = <T>(url: string, data: unknown = {}) => api<T>(request, "POST", url, data);
  const get = <T>(url: string) => api<T>(request, "GET", url);

  // A server that was already seeded (a second run against the same data root) is read back instead of seeded again.
  const existing = await get<Obj[]>("/api/v1/tasks");
  const marker = existing.find((task) => task.frontmatter.title === LONG_TASK_TITLE);
  if (marker) return readBack(get);

  const projects: Seeded[] = [];
  for (const title of ["Atlas migration (example.com)", "Harbor onboarding"]) {
    projects.push(pick(await post<Obj>("/api/v1/entities/project", { fields: { title, objective: `Synthetic objective for ${title}.` } })));
  }
  const people: Seeded[] = [];
  for (const [title, given, family] of [["Alex Example", "Alex", "Example"], ["Sam Sample", "Sam", "Sample"]] as const) {
    people.push(pick(await post<Obj>("/api/v1/entities/person", { fields: { title, given_name: given, family_name: family, organization_name: "Example Org" } })));
  }

  const verbs = ["Draft", "Review", "Send", "Schedule", "Prepare", "Confirm", "Update", "Archive", "Plan", "Follow up on"];
  const objects = ["the sizing deck", "the pilot agenda", "vendor invoices", "the onboarding checklist", "the risk register", "meeting notes", "the Q4 roadmap"];
  const priorities = ["High", "Medium", "Low", undefined] as const;
  const tasks: Seeded[] = [];
  for (let i = 0; i < 32; i += 1) {
    const title = `${verbs[i % verbs.length]} ${objects[i % objects.length]} #${i + 1}`;
    const day = String(1 + (i % 28)).padStart(2, "0");
    const fields: Record<string, unknown> = { title, status: i % 7 === 3 ? "Next" : "Inbox", primary_project_id: projects[i % 2]!.id };
    const priority = priorities[i % priorities.length];
    if (priority) fields.priority = priority;
    if (i % 3 !== 2) fields.due_on = `2026-11-${day}`;
    tasks.push(pick(await post<Obj>("/api/v1/entities/task", { fields })));
  }
  const longTitleTask = pick(await post<Obj>("/api/v1/entities/task", { fields: { title: LONG_TASK_TITLE, priority: "High", due_on: "2026-11-30", primary_project_id: projects[0]!.id } }));
  tasks.push(longTitleTask);

  const decisions: Seeded[] = [];
  for (const [title, text] of [["Adopt weekly planning reviews", "We hold a weekly planning review."], ["Use Markdown as the source of truth", "Notes stay in portable Markdown."], ["Pilot with two teams first", "Start the pilot with two teams at example.com."]] as const) {
    decisions.push(pick(await post<Obj>("/api/v1/decisions", { fields: { title, decision_text: text, rationale: "Synthetic rationale.", primary_project_id: projects[0]!.id } })));
  }
  const openPoints: Seeded[] = [];
  for (const title of ["Who signs off the vendor contract?", "Which region hosts the pilot?", "When does the freeze start?"]) {
    openPoints.push(pick(await post<Obj>("/api/v1/open-points", { fields: { title, importance: "Medium", primary_project_id: projects[1]!.id } })));
  }

  // Adopt the Inbox Drafts serve.mjs wrote (knowledge notes and agent-extracted proposals); the server may already have done it.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await post("/api/v1/inbox/adopt");
    const [notes, reviews] = await Promise.all([get<Obj[]>("/api/v1/knowledge"), get<Obj[]>("/api/v1/review-items")]);
    if (notes.length >= 12 && reviews.length >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const rest = await readBack(get);
  return { ...rest, tasks, longTitleTask, projects, people, decisions, openPoints };
}

async function readBack(get: <T>(url: string) => Promise<T>): Promise<SeedData> {
  const list = async (url: string) => (await get<Obj[]>(url)).map(pick);
  const [tasks, projects, people, decisions, openPoints, knowledgeNotes, reviewItems] = await Promise.all([
    list("/api/v1/tasks"), list("/api/v1/entities/project"), list("/api/v1/entities/person"), list("/api/v1/decisions"), list("/api/v1/open-points"), list("/api/v1/knowledge"), list("/api/v1/review-items")
  ]);
  const long = knowledgeNotes.find((note) => note.title === "Browser knowledge note 1");
  const longTitleTask = tasks.find((task) => task.title === LONG_TASK_TITLE);
  if (!long || !longTitleTask) throw new Error("Seed data is incomplete");
  return { tasks, longTitleTask, projects, people: people.filter((p) => p.title !== "You"), decisions, openPoints, knowledgeNotes, longKnowledgeNote: long, reviewItems, recurringNote: RECURRING_NOTE };
}
