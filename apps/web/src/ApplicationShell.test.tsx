// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationShell, navigationCollapsedKey } from "./ApplicationShell.js";
import { views } from "./routes.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function button(name: string) {
  return [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name) as HTMLButtonElement | undefined;
}

describe("ApplicationShell", () => {
  it("renders the approved destination groups and keeps Settings at the bottom", () => {
    act(() => root!.render(<ApplicationShell activeView="Today" pendingReviewCount={2} status="Ready" onNavigate={vi.fn()} onSearch={vi.fn()} onCapture={vi.fn()}><p>Page</p></ApplicationShell>));

    const groups = [...document.querySelectorAll("nav[aria-label='Primary'] [role='list']")].map((group) => [...group.querySelectorAll("button")].map((item) => item.getAttribute("aria-label")));
    expect(groups).toEqual([
      ["Today", "Calendar", "Tasks", "Notes", "Inbox"],
      ["Decisions", "Open Points", "Knowledge"]
    ]);
    expect([...document.querySelectorAll(".shell-sidebar-footer button")].map((item) => item.getAttribute("aria-label"))).toEqual(["System", "Settings"]);
    expect(document.querySelector(".shell-sidebar-footer")?.textContent).toContain("Settings");
    expect(document.querySelector("aside")?.textContent).not.toMatch(/Projects|Clients|Products|People/);
    expect(button("Search")).toBeTruthy();
    expect(button("Capture")).toBeTruthy();
    expect(document.querySelector("button[aria-current='page']")?.textContent).toContain("Today");
  });

  it("uses accessible icon controls when collapsed and remembers the choice on this device", () => {
    act(() => root!.render(<ApplicationShell activeView="Notes" status="Ready" onNavigate={vi.fn()} onSearch={vi.fn()} onCapture={vi.fn()}><p>Page</p></ApplicationShell>));
    act(() => button("Collapse navigation")!.click());

    expect(document.querySelector(".application-shell")?.classList.contains("navigation-collapsed")).toBe(true);
    expect(button("Expand navigation")).toBeTruthy();
    expect(button("Notes")?.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(localStorage.getItem(navigationCollapsedKey)).toBe("true");

    act(() => root!.unmount());
    root = createRoot(host!);
    act(() => root!.render(<ApplicationShell activeView="Today" status="Ready" onNavigate={vi.fn()} onSearch={vi.fn()} onCapture={vi.fn()}><p>Page</p></ApplicationShell>));
    expect(document.querySelector(".application-shell")?.classList.contains("navigation-collapsed")).toBe(true);
  });

  it("exposes navigation, Search and Capture through public controls", () => {
    const onNavigate = vi.fn();
    const onSearch = vi.fn();
    const onCapture = vi.fn();
    act(() => root!.render(<ApplicationShell activeView="Today" status="Ready" onNavigate={onNavigate} onSearch={onSearch} onCapture={onCapture}><p>Page</p></ApplicationShell>));

    act(() => button("Calendar")!.click());
    act(() => button("Search")!.click());
    act(() => button("Capture")!.click());

    expect(onNavigate).toHaveBeenCalledWith("Calendar");
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onCapture).toHaveBeenCalledOnce();
  });

  it("opens Search with the platform keyboard shortcut without navigating", () => {
    const onNavigate = vi.fn(); const onSearch = vi.fn();
    act(() => root!.render(<ApplicationShell activeView="Today" status="Ready" onNavigate={onNavigate} onSearch={onSearch} onCapture={vi.fn()}><p>Page</p></ApplicationShell>));
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    act(() => document.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("opens Search with Ctrl+K from every routed workspace and keeps the current URL", () => {
    const onNavigate = vi.fn(); const onSearch = vi.fn();
    history.replaceState(null, "", "/notes/example");
    for (const activeView of views) {
      act(() => root!.render(<ApplicationShell activeView={activeView} status="Ready" onNavigate={onNavigate} onSearch={onSearch} onCapture={vi.fn()}><p>{activeView}</p></ApplicationShell>));
      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "K", ctrlKey: true, bubbles: true, cancelable: true })));
    }
    expect(onSearch).toHaveBeenCalledTimes(views.length);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/notes/example");
  });
});
