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
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
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

  it("opens Capture with Cmd/Ctrl+Shift+C from every routed workspace without navigating", () => {
    const onNavigate = vi.fn(); const onCapture = vi.fn();
    history.replaceState(null, "", "/calendar/2026-10-11");
    for (const activeView of views) {
      act(() => root!.render(<ApplicationShell activeView={activeView} status="Ready" onNavigate={onNavigate} onSearch={vi.fn()} onCapture={onCapture}><p>{activeView}</p></ApplicationShell>));
      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    }
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "C", metaKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    expect(onCapture).toHaveBeenCalledTimes(views.length + 1);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/calendar/2026-10-11");
  });

  it("publishes the workspace band after the sidebar and the short-height treatment (#154)", () => {
    setViewport(1280, 800);
    act(() => root!.render(<ApplicationShell activeView="Today" status="Ready" onNavigate={vi.fn()} onSearch={vi.fn()} onCapture={vi.fn()}><p>Page</p></ApplicationShell>));
    const shell = document.querySelector(".application-shell")!;
    expect(shell.getAttribute("data-band")).toBe("compact");
    expect(shell.getAttribute("data-height")).toBe("short");
    act(() => button("Collapse navigation")!.click());
    expect(shell.getAttribute("data-band")).toBe("standard");
    setViewport(2560, 1440);
    expect(shell.getAttribute("data-band")).toBe("wide");
    expect(shell.getAttribute("data-height")).toBe("regular");
  });

  it("replaces the sidebar with Menu, Search and Capture in the narrow band; the sheet returns focus to Menu", () => {
    setViewport(700, 900);
    const onNavigate = vi.fn(); const onSearch = vi.fn(); const onCapture = vi.fn();
    act(() => root!.render(<ApplicationShell activeView="Tasks" status="Ready" onNavigate={onNavigate} onSearch={onSearch} onCapture={onCapture}><p>Page</p></ApplicationShell>));
    expect(document.querySelector("aside.shell-sidebar")).toBeNull();
    act(() => button("Search")!.click()); act(() => button("Capture")!.click());
    expect(onSearch).toHaveBeenCalledOnce(); expect(onCapture).toHaveBeenCalledOnce();
    const menu = button("Menu")!; menu.focus();
    act(() => menu.click());
    expect(document.querySelector("[role='dialog'][aria-label='Navigation']")).toBeTruthy();
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(menu);
    act(() => menu.click());
    act(() => button("Notes")!.click());
    expect(onNavigate).toHaveBeenCalledWith("Notes");
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("offers a skip link that moves focus past navigation to the workspace", () => {
    act(() => root!.render(<ApplicationShell activeView="Today" status="Ready" onNavigate={vi.fn()} onSearch={vi.fn()} onCapture={vi.fn()}><h2>Page</h2></ApplicationShell>));
    const skip = [...document.querySelectorAll("a")].find((link) => link.textContent === "Skip to content")!;
    expect(document.querySelector(".application-shell")!.firstElementChild).toBe(skip);
    act(() => skip.click());
    expect(document.activeElement?.id).toBe("lifeos-content");
    expect(document.activeElement?.tagName).toBe("MAIN");
  });
});

function setViewport(width: number, height: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    window.dispatchEvent(new Event("resize"));
  });
}
