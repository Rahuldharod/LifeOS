import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { PermanentDeleteDialog, purgeNote } from "./PermanentDelete.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const note = { frontmatter: { id: "0190a1b2-0000-7000-8000-000000000001", title: "Old sync notes" }, contentHash: "hash-1" };
const task = { id: "0190a1b2-0000-7000-8000-000000000002", type: "task", title: "Follow up" };
const linking = { id: "0190a1b2-0000-7000-8000-000000000003", type: "knowledge-note", title: "Pricing ideas" };

const render = (check: { blockers: typeof task[]; bodyLinks: typeof task[] }) =>
  renderToStaticMarkup(<PermanentDeleteDialog title={note.frontmatter.title} check={check} busy={false} onConfirm={noop} onCancel={noop} onOpen={noop} />);

describe("PermanentDeleteDialog (PB-030)", () => {
  it("names the note, says it cannot be undone from the app and that backups still hold it", () => {
    const html = render({ blockers: [], bodyLinks: [] });
    expect(html).toContain('role="dialog"');
    expect(text(html)).toContain("Delete “Old sync notes” permanently?");
    expect(text(html)).toContain("cannot be undone from the app");
    expect(text(html)).toContain("Backups still hold it");
    expect(html).toMatch(/<button type="button" class="danger"[^>]*>Delete permanently<\/button>/);
  });

  it("lists body links as a warning and still offers the delete", () => {
    const html = render({ blockers: [], bodyLinks: [linking] });
    expect(text(html)).toContain("These notes link to it; their links will show as missing.");
    expect(html).toMatch(/<button type="button" class="link-button"[^>]*>Pricing ideas<\/button>/);
    expect(html).toMatch(/>Delete permanently<\/button>/);
  });

  it("lists front-matter references as links and offers no delete", () => {
    const html = render({ blockers: [task], bodyLinks: [] });
    expect(text(html)).toContain("still referenced");
    expect(html).toMatch(/<button type="button" class="link-button"[^>]*>Follow up<\/button>/);
    expect(html).not.toMatch(/>Delete permanently<\/button>/);
  });
});

describe("purgeNote (PB-030)", () => {
  it("sends the expected hash to the permanent-delete route", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    await purgeNote(note, async <T,>(url: string, options?: RequestInit) => { calls.push([url, options]); return {} as T; });
    expect(calls).toEqual([[`/api/v1/notes/${note.frontmatter.id}/permanent`, { method: "DELETE", body: JSON.stringify({ expectedHash: "hash-1" }) }]]);
  });

  it("turns a conflict into a plain message", async () => {
    const failing = async <T,>(): Promise<T> => { throw new ApiError("Object changed since it was opened", 409); };
    await expect(purgeNote(note, failing)).rejects.toThrow("changed elsewhere");
  });
});
