import React, { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { GuardedEditor } from "./navigationGuard.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";
import { listClamps } from "./workspaceLayout.js";
import "./SettingsWorkspace.css";

export type SettingsCardDraft = { dirty: boolean; save: () => Promise<boolean>; discard: () => void };
export type SettingsEditorGuard = GuardedEditor;
export const createSettingsEditorGuard = (): SettingsEditorGuard => ({ dirty: false, conflict: false, saveNow: async () => true });

export type SettingsCard = { id: string; label: string; safeStatus?: string; safeNames?: string[]; content: ReactNode };
export type SettingsSection = { id: string; group: "My LifeOS" | "Connections" | "Data & devices" | "Reference data"; label: string; cards: SettingsCard[] };

type Registration = { register: (id: string, read: () => SettingsCardDraft) => () => void; changed: () => void };
const DraftContext = createContext<Registration | undefined>(undefined);

/** Registers one independently saved Settings card with the workspace departure guard. */
export function useSettingsCardGuard(id: string, state: SettingsCardDraft) {
  const registry = useContext(DraftContext); const latest = useRef(state); latest.current = state;
  useEffect(() => {
    if (!registry) return;
    return registry.register(id, () => latest.current);
  }, [id, registry]);
  useEffect(() => { registry?.changed(); }, [registry, state.dirty]);
}

export function SettingsWorkspace({ sections, selectedCardId, loading = false, failure, readOnly, guard, onOpenCard }: {
  sections: SettingsSection[]; selectedCardId?: string; loading?: boolean; failure?: string; readOnly: boolean; guard: SettingsEditorGuard; onOpenCard?: (cardId: string) => void;
}) {
  const narrow = useNarrowWorkspace();
  const deepLinkedSectionId = sections.find((section) => section.cards.some((card) => card.id === selectedCardId))?.id;
  const initial = deepLinkedSectionId ?? sections[0]?.id;
  const [selectedSectionId, setSelectedSectionId] = useState<string | undefined>(() => narrow && !selectedCardId ? undefined : initial);
  const [query, setQuery] = useState(""); const [version, setVersion] = useState(0);
  const [decision, setDecision] = useState<((value: boolean) => void)>(); const [saveFailed, setSaveFailed] = useState(false);
  const entries = useRef(new Map<string, () => SettingsCardDraft>());

  const registration = useMemo<Registration>(() => ({
    register: (id, read) => { entries.current.set(id, read); setVersion((value) => value + 1); return () => { if (entries.current.get(id) === read) entries.current.delete(id); }; },
    changed: () => setVersion((value) => value + 1)
  }), []);
  const drafts = () => [...entries.current.values()].map((read) => read()).filter((entry) => entry.dirty);
  const requestDecision = () => drafts().length ? new Promise<boolean>((resolve) => { setSaveFailed(false); setDecision(() => resolve); }) : Promise.resolve(true);
  guard.dirty = drafts().length > 0; guard.conflict = false; guard.saveNow = requestDecision;
  useEffect(() => () => { guard.dirty = false; guard.saveNow = async () => true; }, [guard]);

  useEffect(() => {
    if (!selectedCardId) return;
    if (deepLinkedSectionId) setSelectedSectionId(deepLinkedSectionId);
  }, [selectedCardId, deepLinkedSectionId]);
  useEffect(() => {
    if (!selectedCardId) return;
    const timer = window.setTimeout(() => document.getElementById(selectedCardId)?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [selectedCardId, selectedSectionId]);

  const finishDecision = async (choice: "save" | "discard" | "stay") => {
    const resolve = decision; if (!resolve) return;
    if (choice === "save") {
      if (readOnly) { setSaveFailed(true); return; }
      for (const draft of drafts()) if (!(await draft.save())) { setSaveFailed(true); return; }
    }
    if (choice === "discard") drafts().forEach((draft) => draft.discard());
    setDecision(undefined); resolve(choice !== "stay");
  };
  const choose = async (sectionId: string, cardId?: string) => {
    if (!(await requestDecision())) return;
    setSelectedSectionId(sectionId);
    const first = cardId ?? sections.find((section) => section.id === sectionId)?.cards[0]?.id;
    if (first) onOpenCard?.(first);
  };
  const back = async () => {
    if (!(await requestDecision())) return;
    setSelectedSectionId(undefined);
  };
  const selected = sections.find((section) => section.id === selectedSectionId);
  const normalisedQuery = query.trim().toLocaleLowerCase();
  const matches = normalisedQuery ? sections.flatMap((section) => section.cards.map((card) => ({ section, card }))).filter(({ section, card }) =>
    [section.group, section.label, card.label, card.safeStatus, ...(card.safeNames ?? [])].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(normalisedQuery))) : [];

  const ref = useListDetailReturn(selected?.id);
  const railStyle = { "--list-min": `${listClamps.settings.min}px`, "--list-max": `${listClamps.settings.max}px` } as React.CSSProperties;
  return <DraftContext.Provider value={registration}><div ref={ref} className={`settings-workspace pane-workspace${selected ? " section-open detail-open" : ""}`} data-workspace="settings" style={railStyle} data-version={version}>
    <aside className="settings-rail" data-pane="list" aria-label="Settings sections" hidden={narrow && Boolean(selected)}>
      <header><span>SETTINGS</span><h2>Settings</h2><p>Preferences save one card at a time.</p></header>
      <input type="search" aria-label="Search settings" placeholder="Search settings…" value={query} onChange={(event) => setQuery(event.target.value)} />
      {normalisedQuery ? <div className="settings-search-results" aria-label="Settings search results">{matches.length ? matches.map(({ section, card }) => <button key={card.id} onClick={() => void choose(section.id, card.id)}><strong>{card.label}</strong><small>{[section.group, card.safeStatus].filter(Boolean).join(" · ")}</small></button>) : <p>No settings found.</p>}</div> : <nav>{["My LifeOS", "Connections", "Data & devices", "Reference data"].map((group) => <div key={group}><span>{group}</span>{sections.filter((section) => section.group === group).map((section) => <button key={section.id} className={selected?.id === section.id ? "selected" : ""} aria-current={selected?.id === section.id ? "page" : undefined} onClick={() => void choose(section.id)}>{section.label}</button>)}</div>)}</nav>}
    </aside>
    <section className="settings-section" data-pane="detail" aria-label="Settings section" hidden={narrow && !selected}>
      <button className="settings-back" aria-label="Back to settings sections" onClick={() => void back()}>Back</button>
      {readOnly && <p className="settings-read-only">Read-only on this Mac. Synced settings cannot be changed until this device holds the write lease.</p>}
      {loading ? <div className="settings-state" aria-busy="true">Loading settings…</div> : failure ? <div className="settings-state settings-failure" role="alert">{failure}</div> : selected ? <><header className="settings-section-heading"><span>{selected.group}</span><h2 data-detail-heading tabIndex={-1}>{selected.label}</h2></header>{selected.cards.map((card) => <div id={card.id} tabIndex={-1} className="settings-card-slot" key={card.id}>{card.content}</div>)}</> : <div className="settings-state">Choose a Settings section.</div>}
    </section>
    {decision && <div className="settings-dialog-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="settings-leave-title" className="settings-leave-dialog"><h3 id="settings-leave-title">Unsaved Settings changes</h3><p>{readOnly ? "This device lost write access. Discard the changes or stay on this card." : "Save or discard each changed card before leaving."}</p>{saveFailed && <p role="alert">A card could not be saved. Your input is still here.</p>}<div><button className="primary" disabled={readOnly} onClick={() => void finishDecision("save")}>Save</button><button onClick={() => void finishDecision("discard")}>Discard</button><button onClick={() => void finishDecision("stay")}>Stay</button></div></div></div>}
  </div></DraftContext.Provider>;
}
