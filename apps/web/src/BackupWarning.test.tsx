import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupWarning } from "./BackupWarning.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;

describe("BackupWarning (#84)", () => {
  it("says in words what failed and why, with a Back up now button", () => {
    const html = renderToStaticMarkup(<BackupWarning warning={{ kind: "off-drive-failed", message: "Off-Drive backup copy failed", reason: "Off-Drive backup folder not found: /Volumes/Example" }} disabled={false} onBackUpNow={noop} />);
    expect(text(html)).toContain("BACKUP PROBLEM");
    expect(text(html)).toContain("Off-Drive backup copy failed");
    expect(text(html)).toContain("Reason: Off-Drive backup folder not found: /Volumes/Example");
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button type="button"[^>]*>Back up now<\/button>/);
  });

  it("disables the button on a read-only device", () => {
    const html = renderToStaticMarkup(<BackupWarning warning={{ kind: "overdue", message: "No backup in the last 26 hours", reason: "No backup has been taken yet." }} disabled onBackUpNow={noop} />);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Back up now<\/button>/);
  });

  it("renders nothing when backups are healthy", () => {
    expect(renderToStaticMarkup(<BackupWarning warning={undefined} disabled={false} onBackUpNow={noop} />)).toBe("");
  });
});
