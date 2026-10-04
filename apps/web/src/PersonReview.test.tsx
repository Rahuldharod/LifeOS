import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonName } from "./PersonName.js";
import { PersonReviewControl } from "./PersonReview.js";
import { labelMap, personLabel } from "./personLabels.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("unreviewed people (#87, PRD story 72)", () => {
  it("adds an 'unreviewed' text marker to person labels, never colour alone", () => {
    expect(text(renderToStaticMarkup(<PersonName name="Jean" suffix=" - ext" unreviewed />))).toBe("Jean - ext · unreviewed");
    expect(text(renderToStaticMarkup(<PersonName name="Jean" />))).toBe("Jean");
  });

  it("carries the flag from the server labels through personLabel", () => {
    const labels = labelMap([{ id: "p1", name: "Jean", label: "Jean", isExternal: false, externalSource: "email", unreviewed: true }]);
    expect(personLabel(labels, { frontmatter: { id: "p1", title: "Jean Dupont" } }).unreviewed).toBe(true);
  });

  it("shows the marker and a Confirm button on the People card while unreviewed, and nothing once reviewed", () => {
    const html = renderToStaticMarkup(<PersonReviewControl person={{ frontmatter: { id: "p1", title: "Jean Dupont", review_state: "unreviewed", origin: "calendar" } }} disabled={false} onConfirm={() => undefined} />);
    expect(text(html)).toContain("Unreviewed");
    expect(text(html)).toContain("created from a calendar invite");
    expect(html).toContain('aria-label="Confirm Jean Dupont as reviewed"');
    expect(renderToStaticMarkup(<PersonReviewControl person={{ frontmatter: { id: "p1", title: "Jean Dupont", review_state: "reviewed" } }} disabled={false} onConfirm={() => undefined} />)).toBe("");
  });
});
