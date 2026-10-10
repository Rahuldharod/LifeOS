import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WarningCard } from "./WarningCard.js";

describe("WarningCard (#97)", () => {
  it("names the problem in words: a label, a heading, then the details and actions", () => {
    const html = renderToStaticMarkup(<WarningCard label="BACKUP PROBLEM" title="Backup failed" role="alert"><p>Reason: disk full</p><button type="button">Back up now</button></WarningCard>);
    expect(html).toBe('<article class="warning-card" role="alert"><span>BACKUP PROBLEM</span><h3>Backup failed</h3><p>Reason: disk full</p><button type="button">Back up now</button></article>');
  });

  it("leaves out the heading when there is no title, and the role when none is given", () => {
    expect(renderToStaticMarkup(<WarningCard label="NOT FOUND"><p>Gone.</p></WarningCard>)).toBe('<article class="warning-card"><span>NOT FOUND</span><p>Gone.</p></article>');
  });
});
