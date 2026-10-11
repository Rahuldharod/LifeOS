// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteConflictPanel } from "./NoteConflictPanel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; });

describe("NoteConflictPanel", () => {
  it("shows readable browser and current-file versions before optional precise changes", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<NoteConflictPanel noteTitle="Weekly note" draftText="# Browser heading\n\nBrowser words" diskText="# File heading\n\nFile words" disabled={false} onKeepBrowserVersion={vi.fn()} onKeepDiskVersion={vi.fn()} />));
    expect(document.querySelectorAll(".note-conflict-rendered h1")).toHaveLength(2);
    expect(document.querySelector(".diff-line")).toBeNull();
    const toggle = [...document.querySelectorAll("button")].find((button) => button.textContent === "Show precise changes") as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(document.querySelector(".diff-line")).toBeTruthy();
    expect(toggle.textContent).toBe("Show readable versions");
  });

  it("preserves the two explicit resolution choices", async () => {
    const browser = vi.fn(); const disk = vi.fn();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<NoteConflictPanel noteTitle="Weekly note" draftText="Browser" diskText="File" disabled={false} onKeepBrowserVersion={browser} onKeepDiskVersion={disk} />));
    const buttons = [...document.querySelectorAll("button")];
    await act(async () => (buttons.find((button) => button.textContent === "Keep browser version") as HTMLButtonElement).click());
    await act(async () => (buttons.find((button) => button.textContent === "Keep current file") as HTMLButtonElement).click());
    expect(browser).toHaveBeenCalledOnce();
    expect(disk).toHaveBeenCalledOnce();
  });

  it("returns to readable versions when the reused panel receives another conflict", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const render = (title: string, draftText: string, diskText: string) => root!.render(<NoteConflictPanel noteTitle={title} draftText={draftText} diskText={diskText} disabled={false} onKeepBrowserVersion={vi.fn()} onKeepDiskVersion={vi.fn()} />);
    await act(async () => render("First note", "# Browser one", "# File one"));
    const precise = [...document.querySelectorAll("button")].find((button) => button.textContent === "Show precise changes") as HTMLButtonElement;
    await act(async () => precise.click());
    expect(document.querySelector(".diff-line")).toBeTruthy();

    await act(async () => render("Second note", "# Browser two", "# File two"));
    expect(document.querySelector(".diff-line")).toBeNull();
    expect(document.querySelectorAll(".note-conflict-rendered h1")).toHaveLength(2);
    expect(document.querySelector(".note-conflict-mode")?.textContent).toBe("Show precise changes");
  });
});
