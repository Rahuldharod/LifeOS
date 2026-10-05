import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeSourceForm, knowledgeSkillHelp, sourcePreservedToast } from "./KnowledgeSourceForm.js";
import { MeetingNoteActions, meetingEnrichmentHelp } from "./MeetingNoteActions.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;

describe("#98: Save and Preserve only save; AI work points to the Claude skills", () => {
  it("the meeting note offers Save, never 'process', and points to LifeOS enrichment", () => {
    const html = renderToStaticMarkup(<MeetingNoteActions canDelete deleteDisabled={false} saveDisabled={false} onDelete={noop} onSave={noop} />);
    expect(html).toMatch(/<button type="button" class="primary"[^>]*>Save<\/button>/);
    expect(html).toContain(">Delete note</button>");
    expect(text(html)).not.toMatch(/process/i);
    expect(html).toContain(meetingEnrichmentHelp);
    expect(meetingEnrichmentHelp).toContain("ask Claude to run LifeOS enrichment");
  });

  it("the Knowledge form offers Preserve, never 'process', and says Claude proposes the notes", () => {
    const html = renderToStaticMarkup(<KnowledgeSourceForm title="Podcast" text="Personalisation beats discounts." disabled={false} onTitleChange={noop} onTextChange={noop} onPreserve={noop} />);
    expect(html).toMatch(/<button type="button" class="primary">Preserve<\/button>/);
    expect(text(html)).not.toMatch(/process/i);
    expect(text(html)).toContain(knowledgeSkillHelp);
    expect(knowledgeSkillHelp).toContain("ask Claude to run LifeOS capture");
    expect(sourcePreservedToast).not.toMatch(/process|added to Inbox/i);
    expect(sourcePreservedToast).toContain("Ask Claude to run LifeOS capture");
  });

  it("Preserve stays disabled until a title and text are given", () => {
    const html = renderToStaticMarkup(<KnowledgeSourceForm title=" " text="" disabled={false} onTitleChange={noop} onTextChange={noop} onPreserve={noop} />);
    expect(html).toMatch(/<button type="button" class="primary" disabled="">Preserve<\/button>/);
  });
});
