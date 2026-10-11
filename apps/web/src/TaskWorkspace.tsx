import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LifeObject, PersonLabel } from "@lifeos/contracts";
import { entityLinkFields } from "@lifeos/shared";
import { CopyLink } from "./CopyLink.js";
import { EntityLinkPicker, type Linkable } from "./EntityLinkPicker.js";
import { areaOptions } from "./envelope.js";
import { HistoryLink } from "./HistoryPanel.js";
import { ListDetailWorkspace, RecordHeader, StickyRecordActions, WorkspaceFilterBar } from "./WorkspacePatterns.js";

export type StructuredEditorGuard = { dirty: boolean; conflict: boolean; saveNow: () => Promise<boolean> };
export const createStructuredEditorGuard = (): StructuredEditorGuard => ({ dirty: false, conflict: false, saveNow: async () => true });

type Option = { id: string; title: string };
const taskStatuses = ["Inbox", "Next", "Waiting", "Done", "Cancelled"] as const;
const taskPriorities = ["High", "Medium", "Low"] as const;
type TaskStatus = typeof taskStatuses[number];
type TaskPriority = "" | typeof taskPriorities[number];
export type TaskDraft = {
  title: string; status: TaskStatus; priority: TaskPriority; due_on: string; expected_output: string;
  owner_person_id: string; waiting_for_person_id: string; primary_project_id: string;
  primary_client_id: string; primary_product_id: string; dependency_ids: string[];
  area: string; sensitivity: "normal" | "restricted";
};
type TaskListView = "mine" | "waiting" | "all";
type DueFilter = "" | "overdue" | "today" | "upcoming" | "none";

const text = (value: unknown) => typeof value === "string" ? value : "";
const taskStatus = (value: unknown): TaskStatus => taskStatuses.includes(value as TaskStatus) ? value as TaskStatus : "Inbox";
const taskPriority = (value: unknown): TaskPriority => taskPriorities.includes(value as typeof taskPriorities[number]) ? value as typeof taskPriorities[number] : "";
const taskDraftFrom = (task: LifeObject, selfId?: string): TaskDraft => ({
  title: text(task.frontmatter.title), status: taskStatus(task.frontmatter.status), priority: taskPriority(task.frontmatter.priority),
  due_on: text(task.frontmatter.due_on), expected_output: text(task.frontmatter.expected_output), owner_person_id: text(task.frontmatter.owner_person_id) || selfId || "",
  waiting_for_person_id: text(task.frontmatter.waiting_for_person_id), primary_project_id: text(task.frontmatter.primary_project_id),
  primary_client_id: text(task.frontmatter.primary_client_id), primary_product_id: text(task.frontmatter.primary_product_id),
  dependency_ids: Array.isArray(task.frontmatter.dependency_ids) ? task.frontmatter.dependency_ids.filter((id): id is string => typeof id === "string") : [],
  area: text(task.frontmatter.area), sensitivity: task.frontmatter.sensitivity === "restricted" ? "restricted" : "normal"
});
const blankTaskDraft = (selfId?: string): TaskDraft => ({ title: "", status: "Inbox", priority: "", due_on: "", expected_output: "", owner_person_id: selfId ?? "", waiting_for_person_id: "", primary_project_id: "", primary_client_id: "", primary_product_id: "", dependency_ids: [], area: "", sensitivity: "normal" });
const sameTaskDraft = (a: TaskDraft, b: TaskDraft) => JSON.stringify(a) === JSON.stringify(b);
const taskDueDate = (task: LifeObject) => typeof task.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : "";
const priorityRank = (value: unknown) => ({ High: 0, Medium: 1, Low: 2 }[String(value)] ?? 3);
const taskFieldsForSave = (draft: TaskDraft): Record<string, unknown> => ({
  ...draft,
  priority: draft.priority || null, due_on: draft.due_on || null, expected_output: draft.expected_output || null,
  waiting_for_person_id: draft.waiting_for_person_id || null, primary_project_id: draft.primary_project_id || null,
  primary_client_id: draft.primary_client_id || null, primary_product_id: draft.primary_product_id || null,
  area: draft.area || null
});

function useNarrowWorkspace() {
  const media = "(max-width: 760px)";
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(media).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(media); const update = () => setNarrow(query.matches);
    query.addEventListener("change", update); update();
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function TaskWorkspace({ tasks, linkables, labels, projects, selfId, selectedId, today, guard, busy, readOnly, run, onOpen, onCloseDetail, onCreate, onSave, onDelete, onComplete, onRestored }: {
  tasks: LifeObject[]; linkables: Linkable[]; labels: Map<string, PersonLabel>; projects: Option[]; selfId?: string; selectedId?: string; today: string; guard: StructuredEditorGuard;
  busy: boolean; readOnly: boolean; run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onOpen: (id: string) => void; onCloseDetail: () => void; onCreate: (fields: Record<string, unknown>) => Promise<LifeObject | undefined>;
  onSave: (task: LifeObject, fields: Record<string, unknown>) => Promise<boolean>; onDelete: (task: LifeObject) => Promise<boolean>;
  onComplete: (task: LifeObject, complete: boolean) => Promise<boolean>; onRestored: () => Promise<void>;
}) {
  const [listView, setListView] = useState<TaskListView>("mine");
  const [query, setQuery] = useState(""); const [sort, setSort] = useState("due"); const [advanced, setAdvanced] = useState(false);
  const [status, setStatus] = useState(""); const [priority, setPriority] = useState(""); const [project, setProject] = useState(""); const [dueFilter, setDueFilter] = useState<DueFilter>("");
  const selected = tasks.find((task) => task.frontmatter.id === selectedId);
  const [creating, setCreating] = useState(false); const [draft, setDraft] = useState<TaskDraft>(() => selected ? taskDraftFrom(selected, selfId) : blankTaskDraft(selfId));
  const [baseline, setBaseline] = useState<TaskDraft>(() => selected ? taskDraftFrom(selected, selfId) : blankTaskDraft(selfId));
  const [saved, setSaved] = useState(false); const [decision, setDecision] = useState<((value: boolean) => void) | undefined>();
  const savedId = useRef<string | undefined>(undefined);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const narrow = useNarrowWorkspace();
  const dirty = !sameTaskDraft(draft, baseline);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  useEffect(() => {
    if (creating) return;
    if (dirtyRef.current) return;
    const next = selected ? taskDraftFrom(selected, selfId) : blankTaskDraft(selfId);
    setDraft(next); setBaseline(next);
    if (savedId.current !== selected?.frontmatter.id) setSaved(false);
    savedId.current = undefined;
  }, [selected, creating, selfId]);
  const save = async () => {
    if (!dirty || readOnly) return !dirty;
    const fields = taskFieldsForSave(draft);
    const created = creating ? await onCreate(fields) : undefined;
    const ok = creating ? Boolean(created) : selected ? await onSave(selected, fields) : false;
    if (ok) { savedId.current = created?.frontmatter.id ?? selected?.frontmatter.id; setBaseline(draft); setSaved(true); setCreating(false); }
    return ok;
  };
  const requestLeave = () => dirty ? new Promise<boolean>((resolve) => setDecision(() => resolve)) : Promise.resolve(true);
  guard.dirty = dirty; guard.conflict = false; guard.saveNow = requestLeave;
  useEffect(() => () => { guard.dirty = false; guard.saveNow = async () => true; }, [guard]);

  const visible = useMemo(() => tasks.filter((task) => {
    if (listView === "mine" && task.frontmatter.owner_person_id !== selfId) return false;
    if (listView === "waiting" && task.frontmatter.status !== "Waiting") return false;
    const searchableText = `${task.frontmatter.title} ${task.frontmatter.expected_output ?? ""}`.toLowerCase();
    if (query.trim() && !searchableText.includes(query.trim().toLowerCase())) return false;
    if (status && task.frontmatter.status !== status) return false;
    if (priority && task.frontmatter.priority !== priority) return false;
    if (project && task.frontmatter.primary_project_id !== project) return false;
    const dueDate = taskDueDate(task);
    if (dueFilter === "overdue" && (!dueDate || dueDate >= today)) return false;
    if (dueFilter === "today" && dueDate !== today) return false;
    if (dueFilter === "upcoming" && (!dueDate || dueDate <= today)) return false;
    if (dueFilter === "none" && dueDate) return false;
    return true;
  }).sort((a, b) => sort === "priority" ? priorityRank(a.frontmatter.priority) - priorityRank(b.frontmatter.priority) : sort === "updated" ? String(b.frontmatter.updated_at).localeCompare(String(a.frontmatter.updated_at)) : (taskDueDate(a) || "9999").localeCompare(taskDueDate(b) || "9999")), [tasks, listView, selfId, query, status, priority, project, dueFilter, sort, today]);

  const leaveThen = async (action: () => void | Promise<unknown>) => { if (await requestLeave()) await action(); };
  const startNew = () => void leaveThen(() => { const next = blankTaskDraft(selfId); setCreating(true); setDraft(next); setBaseline(next); setSaved(false); });
  const updateDraft = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); setSaved(false); };
  const updateRelationship = (key: string, value: string | string[] | null) => {
    if (key === "dependency_ids") updateDraft("dependency_ids", Array.isArray(value) ? value : []);
    else updateDraft(key as "owner_person_id" | "waiting_for_person_id" | "primary_project_id" | "primary_client_id" | "primary_product_id", typeof value === "string" ? value : "");
  };
  const clearFilters = () => { setStatus(""); setPriority(""); setProject(""); setDueFilter(""); };
  const finishDecision = async (choice: "save" | "discard" | "stay") => {
    const resolve = decision; if (!resolve) return;
    if (choice === "save" && !(await save())) return;
    if (choice === "discard") setDraft(baseline);
    setDecision(undefined); resolve(choice !== "stay");
  };

  return <ListDetailWorkspace detailOpen={Boolean(selected || creating)}>
    <section className="task-list-pane" aria-label="Tasks list" hidden={narrow && Boolean(selected || creating)}>
      <header className="workspace-heading"><div><span>TASKS · {visible.length}</span><h2>Tasks</h2><p className="muted">Commitments grouped for action.</p></div><button className="primary" disabled={busy || readOnly} onClick={startNew}>New Task</button></header>
      <div className="workspace-tabs" role="group" aria-label="Task views">{[["mine", "My Tasks"], ["waiting", "Waiting on others"], ["all", "All"]].map(([key, label]) => <button key={key} className={listView === key ? "selected" : ""} aria-pressed={listView === key} onClick={() => setListView(key as TaskListView)}>{label}</button>)}</div>
      <WorkspaceFilterBar advanced={advanced} onToggleAdvanced={() => setAdvanced(!advanced)}><input type="search" aria-label="Search tasks" placeholder="Search tasks…" value={query} onChange={(event) => setQuery(event.target.value)} /><select aria-label="Sort tasks" value={sort} onChange={(event) => setSort(event.target.value)}><option value="due">Due date</option><option value="priority">Priority</option><option value="updated">Recently updated</option></select></WorkspaceFilterBar>
      {advanced && <div className="task-advanced-filters"><label>Status<select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Any status</option>{taskStatuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>Priority<select aria-label="Filter by priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">Any priority</option>{taskPriorities.map((value) => <option key={value}>{value}</option>)}</select></label><label>Project<select aria-label="Filter by project" value={project} onChange={(event) => setProject(event.target.value)}><option value="">Any project</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><label>Due<select aria-label="Filter by due period" value={dueFilter} onChange={(event) => setDueFilter(event.target.value as DueFilter)}><option value="">Any time</option><option value="overdue">Overdue</option><option value="today">Today</option><option value="upcoming">Upcoming</option><option value="none">No due date</option></select></label><button onClick={clearFilters}>Clear filters</button></div>}
      <div className="task-rows">{visible.map((task) => { const done = task.frontmatter.status === "Done"; return <div className={task.frontmatter.id === selectedId ? "task-row selected" : "task-row"} key={task.frontmatter.id}><input type="checkbox" aria-label={`${done ? "Reopen" : "Complete"} ${task.frontmatter.title}`} checked={done} disabled={busy || readOnly} onChange={(event) => { const complete = event.target.checked; void leaveThen(() => onComplete(tasksRef.current.find((candidate) => candidate.frontmatter.id === task.frontmatter.id) ?? task, complete)); }} /><button aria-label={`Open task: ${task.frontmatter.title}`} onClick={() => void leaveThen(() => onOpen(task.frontmatter.id))}><strong>{String(task.frontmatter.title)}</strong><small>{[task.frontmatter.priority, projects.find((item) => item.id === task.frontmatter.primary_project_id)?.title, taskDueDate(task) && `due ${taskDueDate(task)}`].filter(Boolean).join(" · ") || String(task.frontmatter.status)}</small></button><span>{String(task.frontmatter.status)}</span></div>; })}{!visible.length && <p className="workspace-empty">No tasks match these filters.</p>}</div>
    </section>
    <section className="task-detail-pane" aria-label="Task detail" hidden={narrow && !selected && !creating}>
      {!selected && !creating ? <div className="workspace-empty"><h3>Select a task</h3><p>Choose a row to inspect and edit it.</p></div> : <>
        <RecordHeader eyebrow={creating ? "NEW TASK" : "TASK"} title={draft.title || "Untitled task"} description="Click the checkbox to complete; click the row to open." onBack={() => void leaveThen(onCloseDetail)} />
        <div className="task-form"><label className="wide">Title<input aria-label="Task title" value={draft.title} disabled={busy || readOnly} onChange={(event) => updateDraft("title", event.target.value)} /></label><label>Status<select value={draft.status} disabled={busy || readOnly} onChange={(event) => updateDraft("status", event.target.value as TaskStatus)}>{taskStatuses.map((value) => <option key={value}>{value}</option>)}</select></label><label>Priority<select value={draft.priority} disabled={busy || readOnly} onChange={(event) => updateDraft("priority", event.target.value as TaskPriority)}><option value="">None</option>{taskPriorities.map((value) => <option key={value}>{value}</option>)}</select></label><label>Due date<input type="date" value={draft.due_on} disabled={busy || readOnly} onChange={(event) => updateDraft("due_on", event.target.value)} /></label>
          {entityLinkFields.task.map((field) => <EntityLinkPicker key={field.key} field={field} value={draft[field.key as keyof TaskDraft]} objects={linkables} labels={labels} selfId={selected?.frontmatter.id ?? ""} disabled={busy || readOnly || (field.key === "waiting_for_person_id" && draft.status !== "Waiting")} onChange={(value) => updateRelationship(field.key, value)} />)}
          <label className="wide">Expected output<input value={draft.expected_output} disabled={busy || readOnly} onChange={(event) => updateDraft("expected_output", event.target.value)} /></label><label>Area<select value={draft.area} disabled={busy || readOnly} onChange={(event) => updateDraft("area", event.target.value)}><option value="">None</option>{areaOptions.map((value) => <option key={value}>{value}</option>)}</select></label><label className="sensitivity-field">Sensitivity<select value={draft.sensitivity} disabled={busy || readOnly} onChange={(event) => updateDraft("sensitivity", event.target.value as TaskDraft["sensitivity"])}><option value="normal">Normal</option><option value="restricted">Restricted</option></select></label></div>
        {!creating && selected && <details className="record-more"><summary>More</summary><div><HistoryLink objectId={selected.frontmatter.id} title={String(selected.frontmatter.title)} disabled={busy || readOnly} run={run} onRestored={onRestored} /><CopyLink object={selected} disabled={busy} /><button className="danger" disabled={busy || readOnly} onClick={() => { if (window.confirm(`Soft-delete ${selected.frontmatter.title}? The Markdown file will be retained.`)) void onDelete(selected); }}>Delete task</button></div></details>}
        <StickyRecordActions status={creating && !dirty ? "Not saved yet" : dirty ? "Unsaved changes" : saved ? "Saved" : "No changes"} busy={busy} saveDisabled={busy || readOnly || !dirty || !draft.title.trim()} onCancel={() => { setDraft(baseline); setSaved(false); if (creating) { setCreating(false); onCloseDetail(); } }} onSave={() => void save()} />
      </>}
    </section>
    {decision && <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="leave-task-title" className="leave-dialog"><h3 id="leave-task-title">Save changes before leaving?</h3><p>Your task has unsaved changes.</p><div><button className="primary" onClick={() => void finishDecision("save")}>Save</button><button onClick={() => void finishDecision("discard")}>Discard</button><button onClick={() => void finishDecision("stay")}>Stay</button></div></section></div>}
  </ListDetailWorkspace>;
}
