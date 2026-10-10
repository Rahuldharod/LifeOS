// #57: the Review Card for a link-resolution item. Candidates are native radio buttons (Tab into the
// group, arrow keys move, Space picks), each shown by display label with the " - ext" marker as text.
// Server errors stay in the card (role=alert) so the user sees why the link was not saved.
import React, { useState } from "react";
import { PersonName } from "./PersonName.js";
import { linkResolutionView, type LinkOption } from "./linkResolution.js";
import type { PersonLabel } from "@lifeos/contracts";

export type LinkCardActions = {
  /** Accepts with `linkTo`; rejects (throws) with the server's message on failure. */
  onLink: (linkTo: string) => Promise<void>;
  /** Creates the missing object titled with the unresolved text and returns it. */
  onCreate: (type: string, title: string) => Promise<LinkOption>;
  onReject: () => Promise<void>;
};

export function LinkResolutionCard({ review, labels, busy, actions }: {
  review: { frontmatter: { id: string; title: string } & Record<string, unknown> };
  labels: Map<string, PersonLabel>;
  busy: boolean;
  actions: LinkCardActions;
}) {
  const view = linkResolutionView(review, labels);
  // An object created here stays pickable, so a failed accept can be retried without creating it twice.
  const [created, setCreated] = useState<LinkOption>();
  const [choice, setChoice] = useState(view.options.length === 1 ? view.options[0]!.id : "");
  const [error, setError] = useState("");
  const pending = review.frontmatter.status === "pending";
  const options = created && !view.options.some((option) => option.id === created.id) ? [...view.options, created] : view.options;
  const groupName = `link-${review.frontmatter.id}`;

  const attempt = async (step: () => Promise<void>) => {
    setError("");
    try { await step(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Something went wrong"); }
  };
  const link = () => attempt(() => actions.onLink(choice));
  const createAndLink = () => attempt(async () => {
    const made = created ?? await actions.onCreate(view.candidateType, view.reference);
    setCreated(made); setChoice(made.id);
    await actions.onLink(made.id);
  });

  return <div className="review-card">
    <b>{review.frontmatter.title}</b>
    <small>link {view.fieldLabel} · {view.problem === "ambiguous" ? "several matches" : "no match"} · {String(review.frontmatter.status)}</small>
    <p>{view.explanation}</p>
    {options.length > 0 && <fieldset className="link-candidates" disabled={!pending || busy}>
      <legend>Link "{view.reference}" to</legend>
      {options.map((option) => <label key={option.id}>
        <input type="radio" name={groupName} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} />
        <PersonName name={option.name} suffix={option.suffix} />
      </label>)}
    </fieldset>}
    {error && <p role="alert" className="review-error">{error}</p>}
    {pending && <div className="review-actions">
      {options.length > 0 && <button className="primary" disabled={busy || !choice} title={choice ? undefined : `Choose the ${view.candidateType} first`} onClick={() => void link()}>Link</button>}
      {view.canCreate && !created && <button className={options.length ? undefined : "primary"} disabled={busy} onClick={() => void createAndLink()}>Create {view.candidateType} "{view.reference}" and link</button>}
      <button className="danger" disabled={busy} onClick={() => void attempt(actions.onReject)}>Reject</button>
    </div>}
  </div>;
}
