import React, { useEffect, useMemo, useState } from "react";
import type { LifeObject, PersonLabel, PersonMergeChoice, PersonMergePreview } from "@lifeos/contracts";
import { entityLinkFields, personMatchesQuery } from "@lifeos/shared";
import { CopyLink } from "./CopyLink.js";
import { EntityLinkPicker, type Linkable } from "./EntityLinkPicker.js";
import { EnvelopeBadges } from "./EnvelopeBadges.js";
import { areaOptions } from "./envelope.js";
import { formatDate } from "./dateFormat.js";
import { HistoryLink } from "./HistoryPanel.js";
import { withOpenedArchived, type LinkedObject } from "./lifeosLinks.js";
import { PersonName } from "./PersonName.js";
import { PersonEmails, type AddEmailOutcome } from "./PersonEmails.js";
import { PersonMergeDialog } from "./PersonMerge.js";
import { PersonReviewControl } from "./PersonReview.js";
import { PeopleBulkPanel, PeopleBulkToast, PeopleFilterBar, PeopleSelectionBar } from "./PeopleBulk.js";
import { defaultPeopleFilters, matchesPeopleFilters, type BulkResult, type PeopleBulkAction, type PeopleFilters } from "./peopleBulkRules.js";
import { externalChoiceOf, personLabel, type ExternalChoice } from "./personLabels.js";
import { foldText } from "./searchOptions.js";
import { useSettingsCardGuard } from "./SettingsWorkspace.js";
import { StickyRecordActions } from "./WorkspacePatterns.js";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useWorkspaceBand } from "./useNarrowWorkspace.js";
import { referenceSettingsCardId, type ReferenceEntityType } from "./referenceSettingsRoutes.js";
import "./ReferenceDataSettings.css";

type Field = { key: string; label: string; kind?: "date" };
const fields: Record<ReferenceEntityType, Field[]> = {
  project: [{ key: "status", label: "Status" }, { key: "objective", label: "Objective" }, { key: "success_criteria", label: "Success criteria" }, { key: "target_end_on", label: "Target end", kind: "date" }],
  client: [{ key: "status", label: "Status" }, { key: "summary", label: "Summary" }, { key: "website_url", label: "Website" }],
  product: [{ key: "status", label: "Status" }, { key: "description", label: "Description" }],
  person: [{ key: "given_name", label: "Given name" }, { key: "family_name", label: "Family name" }, { key: "organization_name", label: "Organization" }, { key: "job_title", label: "Job title" }, { key: "timezone", label: "Timezone" }]
};
const labels: Record<ReferenceEntityType, string> = { project: "Projects", client: "Clients", product: "Products", person: "People" };
const singular: Record<ReferenceEntityType, string> = { project: "project", client: "client", product: "product", person: "person" };
type Draft = Record<string, unknown> & { title: string; area: string; sensitivity: "normal" | "restricted" };

const text = (value: unknown) => typeof value === "string" ? value : "";
const draftFrom = (object: LifeObject, type: ReferenceEntityType): Draft => {
  const draft: Draft = { title: text(object.frontmatter.title), area: text(object.frontmatter.area), sensitivity: object.frontmatter.sensitivity === "restricted" ? "restricted" : "normal" };
  for (const field of fields[type]) draft[field.key] = object.frontmatter[field.key] ?? "";
  for (const field of entityLinkFields[type]) draft[field.key] = object.frontmatter[field.key] ?? (field.multi ? [] : "");
  return draft;
};
const blankDraft = (type: ReferenceEntityType): Draft => {
  const draft: Draft = { title: "", area: "", sensitivity: "normal" };
  for (const field of fields[type]) draft[field.key] = field.key === "status" ? "active" : "";
  for (const field of entityLinkFields[type]) draft[field.key] = field.multi ? [] : "";
  return draft;
};
const sameDraft = (left: Draft, right: Draft) => JSON.stringify(left) === JSON.stringify(right);

export type ReferenceDataSettingsProps = {
  type: ReferenceEntityType;
  objects: LifeObject[];
  linkables: Linkable[];
  personLabels: Map<string, PersonLabel>;
  selectedId?: string;
  busy: boolean;
  readOnly: boolean;
  onOpen: (id?: string) => void;
  onCreate: (type: ReferenceEntityType, fields: Record<string, unknown>) => Promise<LifeObject | undefined>;
  onSave: (object: LifeObject, fields: Record<string, unknown>) => Promise<boolean>;
  onDelete: (object: LifeObject) => Promise<boolean>;
  onSetExternal?: (object: LifeObject, choice: ExternalChoice) => Promise<boolean>;
  onConfirmReviewed?: (object: LifeObject) => Promise<boolean>;
  /** "Not a person": archive this person and ignore its addresses in future invites. Answers whether it was done. */
  onNotAPerson?: (person: LifeObject) => Promise<boolean>;
  /** #213: Manual merge. Without both, the People card shows no "Merge with…" button. */
  onPreviewMerge?: (person: LifeObject, choice: PersonMergeChoice) => Promise<PersonMergePreview>;
  onMergePeople?: (person: LifeObject, choice: PersonMergeChoice) => Promise<LifeObject | undefined>;
  /** #214: edit a person's emails. The card shows the list only when all four merge and email props are given. */
  onAddEmail?: (person: LifeObject, email: string) => Promise<AddEmailOutcome>;
  onRemoveEmail?: (person: LifeObject, email: string) => Promise<boolean>;
  /** #230: "Not a person" People (archived, so not in `objects`); listed when the Type filter asks for them. */
  notAPersonPeople?: LifeObject[];
  /** #230: one action on the selected people. Without it the People card shows no filters or checkboxes. */
  onBulkPeople?: (action: PeopleBulkAction, people: LifeObject[], onProgress?: (done: number, total: number) => void) => Promise<BulkResult | undefined>;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onRestored: () => Promise<void>;
};

export function ReferenceDataSettings({ type, objects: listed, linkables, personLabels, selectedId, busy, readOnly, onOpen, onCreate, onSave, onDelete, onSetExternal, onConfirmReviewed, onNotAPerson, onPreviewMerge, onMergePeople, onAddEmail, onRemoveEmail, notAPersonPeople, onBulkPeople, run, onRestored }: ReferenceDataSettingsProps) {
  const [confirmingNotAPerson, setConfirmingNotAPerson] = useState(false);
  // #230: filters, checkboxes and bulk actions, People only.
  const bulk = type === "person" && Boolean(onBulkPeople);
  const [filters, setFilters] = useState<PeopleFilters>(defaultPeopleFilters);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  /** The last bulk action's outcome, shown as a toast. */
  const [bulkResult, setBulkResult] = useState<BulkResult>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [showBulk, setShowBulk] = useState(false);
  const band = useWorkspaceBand();
  const stacked = band === "narrow" || band === "compact";
  const objects = useMemo(() => {
    const live = withOpenedArchived(listed, linkables as LinkedObject[], type, selectedId) as LifeObject[];
    if (!bulk || !notAPersonPeople?.length) return live;
    const ids = new Set(live.map((object) => object.frontmatter.id));
    return [...live, ...notAPersonPeople.filter((person) => !ids.has(person.frontmatter.id))];
  }, [listed, linkables, type, selectedId, bulk, notAPersonPeople]);
  const selected = selectedId && selectedId !== "new" ? objects.find((object) => object.frontmatter.id === selectedId) : undefined;
  const creating = selectedId === "new";
  const sourceDraft = useMemo(() => selected ? draftFrom(selected, type) : blankDraft(type), [selected, type]);
  const [baseline, setBaseline] = useState(sourceDraft);
  const [draft, setDraft] = useState(sourceDraft);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [pending, setPending] = useState<(() => void) | undefined>();
  const [merging, setMerging] = useState(false);
  /** #214: set when the merge opens from "merge instead?", so the dialog starts on that person's preview. */
  const [mergeOtherId, setMergeOtherId] = useState<string>();
  useEffect(() => { setBaseline(sourceDraft); setDraft(sourceDraft); setSaved(false); setSaveError(""); }, [sourceDraft]);

  const dirty = !sameDraft(draft, baseline);
  const set = (key: string, value: unknown) => { setDraft((current) => ({ ...current, [key]: value })); setSaved(false); setSaveError(""); };
  const save = async (): Promise<boolean> => {
    if (!draft.title.trim() || readOnly) return false;
    let result: LifeObject | boolean | undefined;
    try { result = creating ? await onCreate(type, draft) : selected ? await onSave(selected, draft) : false; }
    catch { result = false; }
    if (!result) { setSaveError(`Could not save this ${singular[type]}. Your changes are still here.`); return false; }
    const savedObject = typeof result === "object" ? result : undefined;
    const next = savedObject ? draftFrom(savedObject, type) : draft;
    setBaseline(next); setDraft(next); setSaved(true); setSaveError("");
    if (savedObject) onOpen(savedObject.frontmatter.id);
    return true;
  };
  const discard = () => { setDraft(baseline); setSaved(false); setSaveError(""); };
  useSettingsCardGuard(referenceSettingsCardId(type), { dirty, save, discard });

  const leave = (action: () => void) => dirty ? setPending(() => action) : action();
  const finishDecision = async (choice: "save" | "discard" | "stay") => {
    if (!pending) return;
    if (choice === "save" && !(await save())) return;
    if (choice === "discard") discard();
    const action = pending; setPending(undefined);
    if (choice !== "stay") action();
  };

  const words = foldText(query).split(/\s+/).filter(Boolean);
  const visible = objects.filter((object) => {
    // #211: People are also found by email address and alias.
    if (type === "person") return personMatchesQuery(object.frontmatter, personLabel(personLabels, object).label, query) && (!bulk || matchesPeopleFilters(object, personLabels, filters));
    return words.every((word) => foldText(String(object.frontmatter.title)).includes(word));
  }).sort((left, right) => String(left.frontmatter.title).localeCompare(String(right.frontmatter.title)));
  const choose = (id?: string) => leave(() => onOpen(id));
  // People hidden by a filter or the search stop counting as selected.
  const selectedPeople = bulk ? visible.filter((object) => checked.has(object.frontmatter.id)) : [];
  const bulkOpen = selectedPeople.length > 0 && (!stacked || showBulk);
  const toggle = (id: string) => leave(() => setChecked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }));
  const selectAll = () => leave(() => setChecked(new Set(visible.map((object) => object.frontmatter.id))));
  const deselectAll = () => { setChecked(new Set()); setShowBulk(false); };
  // A new filter or search starts a new selection, so the panel never acts on people chosen under another view.
  const changeFilters = (next: PeopleFilters) => { setFilters(next); deselectAll(); };
  const changeQuery = (next: string) => { setQuery(next); if (bulk) deselectAll(); };
  const runBulk = async (action: PeopleBulkAction, people: LifeObject[]) => {
    if (!onBulkPeople) return;
    setBulkResult(undefined);
    setProgress({ done: 0, total: people.length });
    const result = await onBulkPeople(action, people, (done, total) => setProgress({ done, total }));
    setProgress(undefined);
    setBulkResult(result);
    // The treated people are done: the selection clears and the panel closes, so the list is ready for the next batch.
    if (result) deselectAll();
    // An archived or deleted person leaves the list, so its record closes too.
    if (result && (action === "archive" || action === "delete") && selected && people.some((person) => person.frontmatter.id === selected.frontmatter.id)) onOpen(undefined);
  };
  const row = (object: LifeObject) => {
    const display = type === "person" ? personLabel(personLabels, object) : { name: String(object.frontmatter.title), label: String(object.frontmatter.title) };
    const state = object.frontmatter.not_a_person === true ? "Not a person" : object.frontmatter.archived_at ? "Archived" : text(object.frontmatter.status) || "Ready";
    const open = <button key={object.frontmatter.id} className={selected?.frontmatter.id === object.frontmatter.id ? "selected" : ""} aria-label={`Open ${singular[type]}: ${display.label}`} onClick={() => choose(object.frontmatter.id)}><strong>{type === "person" ? <PersonName {...display} /> : display.label}</strong><small>{state}</small></button>;
    if (!bulk) return open;
    return <div key={object.frontmatter.id} className="reference-row-check"><input type="checkbox" aria-label={`Select ${display.label}`} checked={checked.has(object.frontmatter.id)} disabled={busy} onChange={() => toggle(object.frontmatter.id)} />{open}</div>;
  };

  return <ReferenceSplit detailKey={bulkOpen ? "selected-people" : creating ? "new" : selected?.frontmatter.id}>
    <aside className="reference-list" data-pane="list" aria-label={`${labels[type]} list`}>
      <header><div><span>REFERENCE DATA</span><h3>{labels[type]}</h3></div><button className="primary" disabled={busy || readOnly} onClick={() => choose("new")}>New {singular[type]}</button></header>
      <input type="search" aria-label={`Search ${labels[type]}`} placeholder={`Search ${labels[type].toLowerCase()}…`} value={query} onChange={(event) => changeQuery(event.target.value)} />
      {bulk && <PeopleFilterBar filters={filters} onChange={changeFilters} />}
      {bulk && <PeopleSelectionBar shown={visible.length} selected={selectedPeople.length} disabled={busy} stacked={stacked} onSelectAll={selectAll} onDeselectAll={deselectAll} onShowActions={() => setShowBulk(true)} />}
      {!visible.length && <p className="reference-empty">{query || (bulk && objects.length) ? `No ${labels[type].toLowerCase()} match.` : `No ${labels[type].toLowerCase()} yet.`}</p>}
      <div className="reference-rows">{visible.map(row)}</div>
    </aside>
    <section className="reference-detail" data-pane="detail" aria-label={bulkOpen ? "Selected people actions" : `${singular[type]} details`}>
      {bulkOpen ? <PeopleBulkPanel selected={selectedPeople} busy={busy} readOnly={readOnly} progress={progress} onDeselectAll={deselectAll} onRun={(action, people) => void runBulk(action, people)} onBack={stacked ? () => setShowBulk(false) : undefined} /> : !selected && !creating ? <div className="reference-empty-detail">Choose a {singular[type]} or create a new one.</div> : <>
        <header className="reference-record-header"><button className="reference-back" onClick={() => choose(undefined)}>Back to {labels[type].toLowerCase()}</button><div><span>{creating ? `NEW ${singular[type].toUpperCase()}` : singular[type].toUpperCase()}</span><h3 data-detail-heading tabIndex={-1}>{creating ? `New ${singular[type]}` : String(selected!.frontmatter.title)}</h3></div></header>
        {selected?.frontmatter.archived_at && <p className="archived-tag">Archived record opened from a direct link</p>}
        <div className="reference-fields">
          <label><small>Title</small><input aria-label={`${singular[type]} title`} value={draft.title} disabled={busy || readOnly} onChange={(event) => set("title", event.target.value)} /></label>
          {fields[type].map((field) => <label key={field.key}><small>{field.label}</small><input aria-label={field.label} type={field.kind === "date" ? "date" : "text"} value={text(draft[field.key])} disabled={busy || readOnly} onChange={(event) => set(field.key, event.target.value)} /></label>)}
          {entityLinkFields[type].map((field) => <EntityLinkPicker key={field.key} field={field} value={draft[field.key]} objects={linkables} labels={personLabels} selfId={selected?.frontmatter.id ?? ""} disabled={busy || readOnly} onChange={(value) => set(field.key, value)} />)}
          <label><small>Area</small><select aria-label="Area" value={draft.area} disabled={busy || readOnly} onChange={(event) => set("area", event.target.value)}>{["", ...areaOptions].map((option) => <option value={option} key={option}>{option || "None"}</option>)}</select></label>
          <label><small>Sensitivity</small><select aria-label="Sensitivity" value={draft.sensitivity} disabled={busy || readOnly} onChange={(event) => set("sensitivity", event.target.value)}><option value="normal">Normal</option><option value="restricted">Restricted</option></select></label>
        </div>
        {selected && type === "person" && <div className="reference-person-controls"><PersonExternalControl person={selected} labels={personLabels} disabled={busy || readOnly || dirty} onChange={onSetExternal} />{onConfirmReviewed && <PersonReviewControl person={selected} disabled={busy || readOnly || dirty} onConfirm={() => { void onConfirmReviewed(selected); }} />}
          {onPreviewMerge && onMergePeople && <button type="button" className="person-merge-open" disabled={busy || readOnly || dirty} onClick={() => { setMergeOtherId(undefined); setMerging(true); }}>Merge with…</button>}
          {onNotAPerson && selected.frontmatter.is_self !== true && <button type="button" disabled={busy || readOnly || dirty} onClick={() => setConfirmingNotAPerson(true)}>Not a person…</button>}</div>}
        {confirmingNotAPerson && selected && onNotAPerson && <div className="person-emails-warning" role="alertdialog" aria-label={`Mark ${selected.frontmatter.title} as not a person?`}>
          <p>Archive {selected.frontmatter.title} and ignore its email address in future calendar invites? Use this for mailing lists and shared mailboxes. You can undo it from Settings, Ignored addresses.</p>
          <button type="button" disabled={busy} onClick={() => void onNotAPerson(selected).then((done) => { if (done) setConfirmingNotAPerson(false); })}>Not a person</button>
          <button type="button" onClick={() => setConfirmingNotAPerson(false)}>Cancel</button>
        </div>}
        {selected && type === "person" && onAddEmail && onRemoveEmail && onPreviewMerge && onMergePeople && <PersonEmails person={selected} disabled={busy || readOnly || dirty} onAdd={(email) => onAddEmail(selected, email)} onRemove={(email) => onRemoveEmail(selected, email)} onMergeInstead={(otherId) => { setMergeOtherId(otherId); setMerging(true); }} />}
        {merging && selected && onPreviewMerge && onMergePeople && <PersonMergeDialog key={mergeOtherId ?? "pick"} person={selected} initialOtherPersonId={mergeOtherId} people={listed} personLabels={personLabels} onPreview={(choice) => onPreviewMerge(selected, choice)} onMerge={(choice) => onMergePeople(selected, choice)} onClose={() => { setMerging(false); setMergeOtherId(undefined); }} onMerged={(kept) => onOpen(kept.frontmatter.id)} />}
        {selected && <div className="reference-record-meta"><EnvelopeBadges frontmatter={selected.frontmatter} />{Boolean(selected.frontmatter.archived_at) && <small className="archived-tag">Archived</small>}<small>Revision {selected.frontmatter.revision} · {formatDate(selected.frontmatter.updated_at)}</small></div>}
        {selected && <details className="record-more"><summary>More</summary><div>{dirty ? <button type="button" className="link-button" disabled>History</button> : <HistoryLink objectId={selected.frontmatter.id} title={String(selected.frontmatter.title)} disabled={busy || readOnly} run={run} onRestored={onRestored} />}<CopyLink object={selected} disabled={busy} /><button className="danger" disabled={busy || readOnly || dirty || selected.frontmatter.is_self === true} onClick={() => { if (window.confirm(`Soft-delete ${selected.frontmatter.title}? The Markdown file will be retained.`)) void onDelete(selected).then((deleted) => { if (deleted) onOpen(undefined); }); }}>Delete {singular[type]}</button></div></details>}
        {saveError && <p className="field-error" role="alert">{saveError}</p>}
        <StickyRecordActions status={creating && !dirty ? "Not saved yet" : dirty ? "Unsaved changes" : saved ? "Saved" : "No changes"} busy={busy} saveDisabled={busy || readOnly || !dirty || !draft.title.trim()} onCancel={() => { discard(); if (creating) onOpen(undefined); }} onSave={() => void save()} />
      </>}
    </section>
    {pending && <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="leave-reference-title" className="leave-dialog"><h3 id="leave-reference-title">Save changes before leaving?</h3><p>This {singular[type]} has unsaved changes.</p><div><button className="primary" disabled={readOnly} onClick={() => void finishDecision("save")}>Save</button><button onClick={() => void finishDecision("discard")}>Discard</button><button onClick={() => void finishDecision("stay")}>Stay</button></div></section></div>}
    {bulk && bulkResult && <PeopleBulkToast result={bulkResult} onClose={() => setBulkResult(undefined)} />}
  </ReferenceSplit>;
}

/**
 * Reference data nests a list and detail inside the Settings section. Both columns show only when the workspace
 * band has room (standard and wide); compact and narrow navigate list → detail instead of squeezing three columns.
 * The `display: none` on the inactive pane (ReferenceDataSettings.css) also removes it from the accessibility tree.
 */
function ReferenceSplit({ detailKey, children }: { detailKey?: string; children: React.ReactNode }) {
  const band = useWorkspaceBand();
  const stacked = band === "narrow" || band === "compact";
  const split = useSplitPane("reference");
  const ref = useListDetailReturn(detailKey);
  const [list, ...rest] = React.Children.toArray(children);
  return <div ref={ref} className={`reference-settings${detailKey ? " detail-open" : ""}`} data-stacked={stacked} style={split.style}>
    {list}{!stacked && <div {...split.dividerProps} />}{rest}
  </div>;
}
function PersonExternalControl({ person, labels, disabled, onChange }: { person: LifeObject; labels: Map<string, PersonLabel>; disabled: boolean; onChange?: (object: LifeObject, choice: ExternalChoice) => Promise<boolean> }) {
  const label = personLabel(labels, person);
  const isSelf = person.frontmatter.is_self === true;
  const derived = labels.get(person.frontmatter.id)?.isExternal ? "external" : "internal";
  return <span className="person-external"><small>Shown as</small><b><PersonName {...label} /></b>{!isSelf && onChange && <label><small>External</small><select aria-label="External person label" value={externalChoiceOf(person.frontmatter)} disabled={disabled} onChange={(event) => { void onChange(person, event.target.value as ExternalChoice); }}><option value="auto">Auto (by email domain{externalChoiceOf(person.frontmatter) === "auto" ? `: ${derived}` : ""})</option><option value="external">External</option><option value="internal">Internal</option></select></label>}</span>;
}
