import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeetingEnrichment, enrichmentView } from "./MeetingEnrichment.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("meeting enrichment state (#87, PRD stories 32 and 40)", () => {
  it("names each state in text and reads unknown values as not requested", () => {
    expect(enrichmentView({}).label).toBe("Not requested");
    expect(enrichmentView({ enrichment_state: "requested" }).label).toBe("Requested");
    expect(enrichmentView({ enrichment_state: "partial" }).label).toBe("Partial");
    expect(enrichmentView({ enrichment_state: "enriched" }).label).toBe("Enriched");
    expect(enrichmentView({ enrichment_state: "gave_up" }).label).toBe("Gave up");
    expect(enrichmentView({ enrichment_state: "bogus" }).label).toBe("Not requested");
  });

  it("offers Give up only while material is still awaited (requested or partial)", () => {
    expect(["none", "requested", "partial", "enriched", "gave_up"].map((state) => enrichmentView({ enrichment_state: state }).canGiveUp)).toEqual([false, true, true, false, false]);
  });

  it("lists missing and unavailable material by name, ignoring unknown kinds", () => {
    const view = enrichmentView({ enrichment_state: "partial", enrichment_missing_material: ["meet-transcript", "gong-call", 7], enrichment_unavailable_material: ["gong-summary-email"] });
    expect(view.missing).toEqual(["Meet transcript", "Gong call"]);
    expect(view.unavailable).toEqual(["Gong summary email"]);
  });

  it("renders state, material and a uniquely named Give up button for a partial meeting", () => {
    const html = renderToStaticMarkup(<MeetingEnrichment title="Pilot kickoff" frontmatter={{ enrichment_state: "partial", enrichment_missing_material: ["meet-recording"], enrichment_unavailable_material: ["gong-call"] }} disabled={false} onGiveUp={() => undefined} />);
    expect(text(html)).toContain("Enrichment Partial");
    expect(text(html)).toContain("Missing material Meet recording");
    expect(text(html)).toContain("Not available Gong call");
    expect(html).toContain('aria-label="Give up waiting for material from Pilot kickoff"');
  });

  it("shows no Give up button and no material lines for an enriched meeting", () => {
    const html = renderToStaticMarkup(<MeetingEnrichment title="QBR" frontmatter={{ enrichment_state: "enriched", enrichment_missing_material: [] }} disabled={false} onGiveUp={() => undefined} />);
    expect(text(html)).toContain("Enrichment Enriched");
    expect(html).not.toContain("<button");
    expect(text(html)).not.toContain("Missing material");
  });
});
