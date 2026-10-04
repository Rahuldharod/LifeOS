import { describe, expect, it } from "vitest";
import { withSummarySection } from "./meeting-material.js";

// #66: the Summary section of a meeting body has explicit boundaries, so a retry never appends it twice,
// a newer summary leaves nothing of the older one behind, and the user's own text is never changed.

const start = "<!-- lifeos:summary:start -->";
const end = "<!-- lifeos:summary:end -->";
const userTop = "# Q3 sync\n\nMy agenda, written by hand.\n";
const headed = "Vendor B chosen.\n\n## Risks\n\n- Budget\n\n# Appendix\n\nTimeline.";

describe("withSummarySection (#66)", () => {
  it("appends a marked section after the user's text", () => {
    const body = withSummarySection(userTop, "Joel confirmed vendor B.");
    expect(body).toBe(`${userTop}\n${start}\n## Summary\n\nJoel confirmed vendor B.\n${end}\n`);
  });

  it("writes a summary containing ## and # headings once, however often it is retried", () => {
    const once = withSummarySection(userTop, headed);
    const twice = withSummarySection(once, headed);
    expect(twice).toBe(once);
    expect(twice.match(/## Risks/g)).toHaveLength(1);
    expect(twice.match(/## Summary/g)).toHaveLength(1);
  });

  it("a newer summary leaves no part of the older one behind", () => {
    const older = withSummarySection(userTop, headed);
    const newer = withSummarySection(older, "A better summary.");
    expect(newer).toBe(withSummarySection(userTop, "A better summary."));
    for (const fragment of ["Vendor B chosen", "## Risks", "Budget", "# Appendix", "Timeline"]) expect(newer).not.toContain(fragment);
  });

  it("never changes user text before or after the section, including the user's own headings", () => {
    const userBottom = "## My follow-ups\n\n- Call Joel\n\n## Summary of my own\ntext";
    const written = withSummarySection(userTop, headed);
    const edited = `${written}${userBottom}\n`;
    const replaced = withSummarySection(edited, "Short.");
    expect(replaced.startsWith(`${userTop}\n${start}\n`)).toBe(true);
    expect(replaced.endsWith(`${end}\n${userBottom}\n`)).toBe(true);
    expect(replaced).toBe(`${userTop}\n${start}\n## Summary\n\nShort.\n${end}\n${userBottom}\n`);
  });

  it("migrates an unmarked summary written before #66, keeping the user's sections after it", () => {
    const legacy = `${userTop}\n## Summary\n\nOld summary.\n\n## Decisions\n\nMine.\n`;
    const migrated = withSummarySection(legacy, "New summary.");
    expect(migrated).toBe(`${userTop}\n${start}\n## Summary\n\nNew summary.\n${end}\n\n## Decisions\n\nMine.\n`);
    expect(withSummarySection(migrated, "New summary.")).toBe(migrated);
  });

  it("migrates an unmarked summary at the very start or the very end of the body", () => {
    expect(withSummarySection("## Summary\n\nOld.\n", "New.")).toBe(`${start}\n## Summary\n\nNew.\n${end}\n`);
    expect(withSummarySection(`${userTop}\n## Summary\n\nOld.\n`, "New.")).toBe(`${userTop}\n${start}\n## Summary\n\nNew.\n${end}\n`);
  });

  it("writes into an empty body", () => {
    expect(withSummarySection("", "Only this.")).toBe(`${start}\n## Summary\n\nOnly this.\n${end}\n`);
  });

  it("a summary that contains the boundary markers cannot move the boundaries", () => {
    const hostile = `Before.\n${end}\n## Injected\n${start}\nAfter.`;
    const written = withSummarySection(userTop, hostile);
    expect(written.match(/lifeos:summary:start/g)).toHaveLength(1);
    expect(written.match(/lifeos:summary:end/g)).toHaveLength(1);
    expect(withSummarySection(written, "Clean.")).toBe(withSummarySection(userTop, "Clean."));
  });

  it("a start marker whose end marker the user deleted is treated like an unmarked summary", () => {
    const broken = `${userTop}\n${start}\n## Summary\n\nOld.\n\n## Mine\n\nKeep me.\n`;
    const fixed = withSummarySection(broken, "New.");
    expect(fixed).toBe(`${userTop}\n${start}\n## Summary\n\nNew.\n${end}\n\n## Mine\n\nKeep me.\n`);
  });

  it("keeps Windows line endings in the user's text untouched", () => {
    const crlf = "# Notes\r\n\r\nMine.\r\n";
    const written = withSummarySection(crlf, "S.");
    expect(written.startsWith(crlf)).toBe(true);
    expect(withSummarySection(written, "S.")).toBe(written);
  });
});

describe("withSummarySection with a stray start marker (#66)", () => {
  it("never reaches past the user's text to a later ## Summary heading of their own", () => {
    const broken = `${start}\nOld.\n\n## Mine\n\nKeep me.\n\n## Summary\n\nMy own summary.\n`;
    const fixed = withSummarySection(broken, "New.");
    expect(fixed).toBe(`${start}\n## Summary\n\nNew.\n${end}\n\n## Mine\n\nKeep me.\n\n## Summary\n\nMy own summary.\n`);
  });
});
