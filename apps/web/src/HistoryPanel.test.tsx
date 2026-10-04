import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryLink, HistoryList, HistoryRow, prunedMessage, restoreEntry, type HistoryEntry } from "./HistoryPanel.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const version = (revision: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  kind: "version", id: `.lifeos/versions/t1/${String(revision).padStart(6, "0")}--abc${revision}.md`, versionPath: `.lifeos/versions/t1/${String(revision).padStart(6, "0")}--abc${revision}.md`,
  at: `2026-10-0${Math.min(revision, 9)}T08:00:00Z`, device: "work-mac", external: false, kept: true, current: false, title: `Title ${revision}`, revision, ...extra
});
const noop = () => undefined;

beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "UTC" }); });

describe("History panel (#85)", () => {
  it("lists kept versions with time, device and whether each was an external edit, newest first as given", () => {
    const entries = [version(3, { current: true }), version(2, { external: true, device: "seen on work-mac" }), { ...version(1), kind: "event" as const, id: "e1", action: "object.changed-externally", external: true }];
    const html = renderToStaticMarkup(<HistoryList entries={entries} disabled={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
    const shown = text(html);
    expect(shown.indexOf("Revision 3")).toBeLessThan(shown.indexOf("Revision 2"));
    expect(shown).toContain("Revision 3 · Title 3 Current");
    expect(shown).toContain("Revision 2 · Title 2 External edit");
    expect(shown).toContain("seen on work-mac");
    expect(shown).toContain("Edited outside LifeOS");
    expect(shown).toMatch(/Oct 2, 2026/);
    // The current version and events offer no restore; the older kept version does.
    expect(html.match(/>Restore this version</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Restore this version: Revision 2 · Title 2,');
  });

  it("caps the list at 7 rows with a keyboard-reachable 'Show N more' button", () => {
    const entries = Array.from({ length: 10 }, (_, index) => version(10 - index));
    const html = renderToStaticMarkup(<HistoryList entries={entries} disabled={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
    expect(html.match(/class="history-row"/g)).toHaveLength(6);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*>Show 4 more<\/button>/);
    expect(renderToStaticMarkup(<HistoryList entries={entries.slice(0, 7)} disabled={false} onAsk={noop} onConfirm={noop} onCancel={noop} />).match(/class="history-row"/g)).toHaveLength(7);
  });

  it("asks for confirmation with real buttons before restoring", () => {
    const html = renderToStaticMarkup(<HistoryRow entry={version(2)} confirming disabled={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain('role="group"');
    expect(html).toMatch(/<button type="button"[^>]*>Confirm restore<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>Cancel<\/button>/);
    expect(html).not.toContain(">Restore this version<");
  });

  it("says a pruned version is no longer kept and offers nothing destructive", () => {
    const pruned: HistoryEntry = { kind: "event", id: "e1", action: "object.changed-externally", at: "2026-10-01T08:00:00Z", device: "work-mac", external: true, versionPath: ".lifeos/versions/t1/000001--abc.md", kept: false, current: false };
    const html = renderToStaticMarkup(<HistoryRow entry={pruned} confirming disabled={false} onAsk={noop} onConfirm={noop} onCancel={noop} />);
    expect(text(html)).toContain(prunedMessage);
    expect(html).not.toContain("<button");
  });

  it("restores through the history endpoint, shows a toast, then reloads the history (which now holds the restore)", async () => {
    const calls: string[] = [];
    const run = vi.fn(async (action: () => Promise<void>, success: string) => { await action(); calls.push(`toast:${success}`); return true; });
    const ok = await restoreEntry("t1", version(2), {
      post: async (url, body) => { calls.push(`post:${url}:${JSON.stringify(body)}`); },
      run, reload: async () => { calls.push("reload"); }, onRestored: async () => { calls.push("refresh"); }
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      `post:/api/v1/objects/t1/history/restore:{"versionPath":".lifeos/versions/t1/000002--abc2.md"}`,
      "reload", "refresh", expect.stringMatching(/^toast:Restored revision 2 from .*2026/)
    ]);
  });

  it("does nothing for a pruned or current version, and reloads after a refused restore", async () => {
    const post = vi.fn();
    const run = vi.fn(async () => true);
    expect(await restoreEntry("t1", version(2, { kept: false }), { post, run, reload: async () => undefined })).toBe(false);
    expect(await restoreEntry("t1", version(3, { current: true }), { post, run, reload: async () => undefined })).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const reload = vi.fn(async () => undefined);
    const failing = async (action: () => Promise<void>) => { await action().catch(() => undefined); return false; };
    await restoreEntry("t1", version(2), { post: async () => { throw new Error(prunedMessage); }, run: failing, reload });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("renders a closed, keyboard-operable 'History' button", () => {
    const html = renderToStaticMarkup(<HistoryLink objectId="t1" title="Task" disabled={false} run={async () => true} />);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*>History<\/button>/);
  });
});
