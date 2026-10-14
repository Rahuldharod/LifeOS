// #214: a Person's email addresses on the People card. Calendar sync adds them; this is for corrections.
// Adding an address that is on another person offers the Manual merge instead; removing asks first.
import React, { useState } from "react";
import type { LifeObject } from "@lifeos/contracts";
import { personEmailAddresses } from "@lifeos/shared";

/** What the page answers after an add: saved, taken by another person (who is named), or failed (the page shows why). */
export type AddEmailOutcome = { kind: "saved" } | { kind: "taken"; person: { id: string; name: string } } | { kind: "failed" };

export type PersonEmailsProps = {
  person: LifeObject;
  disabled: boolean;
  onAdd: (email: string) => Promise<AddEmailOutcome>;
  /** Answers whether the address was removed. */
  onRemove: (email: string) => Promise<boolean>;
  /** Opens the Manual merge with this person already chosen. */
  onMergeInstead: (otherPersonId: string) => void;
};

export function PersonEmails({ person, disabled, onAdd, onRemove, onMergeInstead }: PersonEmailsProps) {
  const emails = personEmailAddresses(person.frontmatter);
  const [value, setValue] = useState("");
  const [taken, setTaken] = useState<{ id: string; name: string }>();
  const [removing, setRemoving] = useState<string>();

  const add = async () => {
    if (!value.trim()) return;
    const outcome = await onAdd(value);
    if (outcome.kind === "saved") { setValue(""); setTaken(undefined); }
    else if (outcome.kind === "taken") setTaken(outcome.person);
  };
  const remove = async (email: string) => { if (await onRemove(email)) setRemoving(undefined); };

  return <fieldset className="person-emails" disabled={disabled}>
    <legend>Email addresses</legend>
    {emails.length === 0 ? <p className="person-emails-empty">No email address yet.</p> : <ul>
      {emails.map((email) => <li key={email}><span>{email}</span>
        <button type="button" aria-label={`Remove ${email}`} onClick={() => setRemoving(email)}>Remove</button></li>)}
    </ul>}
    {removing && <div className="person-emails-warning" role="alertdialog" aria-label={`Remove ${removing}?`}>
      <p>If you remove {removing}, a future invite from this address will create a new unreviewed person. LifeOS will then suggest merging it back.</p>
      <div><button type="button" className="danger" onClick={() => void remove(removing)}>Yes, remove it</button><button type="button" onClick={() => setRemoving(undefined)}>Keep it</button></div>
    </div>}
    <div className="person-emails-add">
      <input type="email" aria-label="Add email address" placeholder="name@example.com" value={value}
        onChange={(event) => { setValue(event.target.value); setTaken(undefined); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(); } }} />
      <button type="button" disabled={!value.trim()} onClick={() => void add()}>Add email</button>
    </div>
    {taken && <p className="person-emails-taken" role="alert">This belongs to {taken.name} — merge instead? <button type="button" className="link-button" onClick={() => onMergeInstead(taken.id)}>Merge with {taken.name}</button></p>}
  </fieldset>;
}
