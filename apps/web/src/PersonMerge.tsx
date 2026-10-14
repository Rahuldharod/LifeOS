// #213: Manual merge from the People card. "Merge with…" picks the other person (search by name, email or alias),
// previews who is kept and which name is kept (each can be swapped), then merges on confirm.
// #214 opens the same dialog already pointed at a chosen person: render <PersonMergeDialog initialOtherPersonId=… />.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LifeObject, PersonLabel, PersonMergeChoice, PersonMergePreview } from "@lifeos/contracts";
import { personMatchesQuery, personSearchTerms } from "@lifeos/shared";
import { OverlayDialog } from "./OverlayDialog.js";
import { PersonName } from "./PersonName.js";
import { personLabel } from "./personLabels.js";

export type PersonMergeDialogProps = {
  /** The person whose card is open. */
  person: LifeObject;
  /** Every live person (the picker excludes `person` itself). */
  people: LifeObject[];
  personLabels: Map<string, PersonLabel>;
  /** When set (for example by #214), the dialog starts on the preview for this person instead of the picker. */
  initialOtherPersonId?: string;
  onPreview: (choice: PersonMergeChoice) => Promise<PersonMergePreview>;
  /** Merges; answers the kept person, or undefined when it failed (the page already shows the error). */
  onMerge: (choice: PersonMergeChoice) => Promise<LifeObject | undefined>;
  onClose: () => void;
  /** Called with the kept person after a merge, so the page can open it (the opened person may be the one merged away). */
  onMerged: (kept: LifeObject) => void;
};

const emailsOf = (person: LifeObject) => personSearchTerms({ identifiers: person.frontmatter.identifiers }).join(", ");

export function PersonMergeDialog({ person, people, personLabels, initialOtherPersonId, onPreview, onMerge, onClose, onMerged }: PersonMergeDialogProps) {
  const [otherId, setOtherId] = useState<string | undefined>(initialOtherPersonId);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<PersonMergePreview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const other = otherId ? people.find((candidate) => candidate.frontmatter.id === otherId) : undefined;

  const candidates = useMemo(() => people
    .filter((candidate) => candidate.frontmatter.id !== person.frontmatter.id)
    .filter((candidate) => personMatchesQuery(candidate.frontmatter, personLabel(personLabels, candidate).label, query))
    .sort((left, right) => String(left.frontmatter.title).localeCompare(String(right.frontmatter.title))), [people, person, personLabels, query]);

  const previewer = useRef(onPreview);
  previewer.current = onPreview;
  const load = useCallback(async (choice: Omit<PersonMergeChoice, "otherPersonId">) => {
    if (!otherId) return;
    setBusy(true); setError("");
    try { setPreview(await previewer.current({ otherPersonId: otherId, ...choice })); }
    catch (failure) { setPreview(undefined); setError(failure instanceof Error ? failure.message : "Could not prepare the merge."); }
    finally { setBusy(false); }
  }, [otherId]);
  useEffect(() => { setPreview(undefined); void load({}); }, [load]);

  // The radio moves at once; the preview (name, aliases, counts) follows when the server answers.
  const choose = (change: Partial<PersonMergeChoice>) => {
    if (!preview) return;
    const next = { keepPersonId: preview.keepPersonId, nameFromPersonId: preview.nameFromPersonId, ...change };
    setPreview({ ...preview, ...next });
    void load(next);
  };
  const confirm = async () => {
    if (!preview || !otherId) return;
    setBusy(true);
    const kept = await onMerge({ otherPersonId: otherId, keepPersonId: preview.keepPersonId, nameFromPersonId: preview.nameFromPersonId }).catch(() => undefined);
    setBusy(false);
    if (kept) { onMerged(kept); onClose(); } else setError("The merge did not finish. Nothing was lost: check the message on the page, then try again.");
  };
  const both = preview ? (preview.keep.id === person.frontmatter.id ? [preview.keep, preview.merge] : [preview.merge, preview.keep]) : [];

  return <OverlayDialog open label={`Merge ${person.frontmatter.title} with another person`} className="person-merge-dialog" onClose={onClose}>
    <div className="person-merge">
      <h3>Merge {String(person.frontmatter.title)} with…</h3>
      {!other ? <>
        <input type="search" data-overlay-autofocus aria-label="Search people to merge with" placeholder="Search by name, email or alias…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {!candidates.length && <p className="reference-empty">No people match.</p>}
        <div className="person-merge-list">{candidates.map((candidate) => {
          const display = personLabel(personLabels, candidate);
          return <button type="button" key={candidate.frontmatter.id} aria-label={`Merge with ${display.label}`} onClick={() => setOtherId(candidate.frontmatter.id)}>
            <strong><PersonName {...display} /></strong><small>{emailsOf(candidate) || "No email"}</small>
          </button>;
        })}</div>
      </> : <>
        {!preview && !error && <p role="status">Preparing the preview…</p>}
        {preview && <>
          <p className="person-merge-lead">{preview.merge.title} is merged into {preview.keep.title}. The merged person is removed from the People list; nothing else is deleted.</p>
          <fieldset disabled={busy || preview.keepLocked}>
            <legend>Person kept</legend>
            {both.map((choice) => <label key={choice.id}><input type="radio" name="merge-keep" checked={preview.keepPersonId === choice.id} onChange={() => choose({ keepPersonId: choice.id })} /> {choice.title}</label>)}
            {preview.keepLocked && <small>You (the Self person) always stay.</small>}
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Name kept</legend>
            {both.map((choice) => <label key={choice.id}><input type="radio" name="merge-name" checked={preview.nameFromPersonId === choice.id} onChange={() => choose({ nameFromPersonId: choice.id })} /> {choice.title}</label>)}
          </fieldset>
          <dl className="person-merge-result" aria-label="Result of the merge">
            <dt>Name</dt><dd>{preview.keptName}</dd>
            <dt>Also known as</dt><dd>{preview.aliases.length ? preview.aliases.join(", ") : "—"}</dd>
            <dt>Emails</dt><dd>{preview.emails.length ? preview.emails.join(", ") : "—"}</dd>
            <dt>Updated</dt><dd>{preview.referenceCount === 1 ? "1 linked item" : `${preview.referenceCount} linked items`} will point to {preview.keptName}</dd>
          </dl>
        </>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </>}
      <div className="person-merge-actions">
        {other && <button type="button" disabled={busy} onClick={() => { setOtherId(undefined); setError(""); }}>Change person</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        {other && <button type="button" className="primary" disabled={busy || !preview} onClick={() => void confirm()}>Merge</button>}
      </div>
    </div>
  </OverlayDialog>;
}
