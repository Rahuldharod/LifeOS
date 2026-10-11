// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import { fakeApi, type FakeCallInput } from "./fakeApi.js";
import { PermanentDeleteDialog, purgeNote } from "./PermanentDelete.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const note = { frontmatter: { id: "0190a1b2-0000-7000-8000-000000000001", title: "Old sync notes" }, contentHash: "hash-1" };
const task = { id: "0190a1b2-0000-7000-8000-000000000002", type: "task", title: "Follow up" };
const linking = { id: "0190a1b2-0000-7000-8000-000000000003", type: "knowledge-note", title: "Pricing ideas" };
let root: Root | undefined;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; });

const render = (check: { blockers: typeof task[]; bodyLinks: typeof task[] }) =>
  renderToStaticMarkup(<PermanentDeleteDialog title={note.frontmatter.title} check={check} busy={false} onConfirm={noop} onCancel={noop} onOpen={noop} />);

describe("PermanentDeleteDialog (PB-030)", () => {
  it("names the note, says it cannot be undone from the app and that backups still hold it", () => {
    const html = render({ blockers: [], bodyLinks: [] });
    expect(html).toContain('role="dialog"');
    expect(text(html)).toContain("Delete “Old sync notes” permanently?");
    expect(text(html)).toContain("cannot be undone from the app");
    expect(text(html)).toContain("Backups still hold it");
    expect(text(html)).toContain(`Type “${note.frontmatter.title}” to confirm.`);
    expect(html).toContain(`Type “${note.frontmatter.title}” to confirm.<input`);
    expect(html).toMatch(/<button type="button" class="danger-confirm" disabled=""[^>]*>Delete permanently<\/button>/);
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

  it("requires the exact visible title before enabling the final delete", async () => {
    const confirm = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(<PermanentDeleteDialog title={note.frontmatter.title} check={{ blockers: [], bodyLinks: [] }} busy={false} onConfirm={confirm} onCancel={noop} onOpen={noop} />));
    const input = host.querySelector("input")!;
    const button = [...host.querySelectorAll("button")].find((control) => control.textContent === "Delete permanently")!;
    expect(button.disabled).toBe(true);
    const setInput = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => setInput("Old sync note"));
    expect(button.disabled).toBe(true);
    await act(async () => setInput(note.frontmatter.title));
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe("purgeNote (PB-030)", () => {
  it("sends the expected hash to the permanent-delete route", async () => {
    const calls: Array<[string, FakeCallInput | undefined]> = [];
    await purgeNote(note, fakeApi((endpoint, input) => { calls.push([endpoint, input]); return {}; }));
    expect(calls).toEqual([["DELETE /api/v1/notes/:id/permanent", { params: { id: note.frontmatter.id }, body: { expectedHash: "hash-1" } }]]);
  });

  it("turns a conflict into a plain message", async () => {
    const failing = fakeApi(() => { throw new ApiError("Object changed since it was opened", 409); });
    await expect(purgeNote(note, failing)).rejects.toThrow("changed elsewhere");
  });
});
