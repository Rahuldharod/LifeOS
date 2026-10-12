// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, LifeObject } from "@lifeos/contracts";
import { GlobalSearchOverlay } from "./GlobalSearchOverlay.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (index: number, type = "task"): LifeObject => ({
  frontmatter: { id: `${type}-${index}`, type, title: `${type} result ${index}`, revision: 1, created_at: "2026-10-01T00:00:00Z", updated_at: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z` },
  body: "matching body", relativePath: `${type}s/${index}.md`, contentHash: String(index)
});
const calendarEvent: CalendarEvent = { externalId: "roadmap", calendarId: "work", title: "Roadmap review", startsAt: "2026-10-12T09:00:00Z", endsAt: "2026-10-12T10:00:00Z", timezone: "Europe/Paris", attendees: [] };

describe("GlobalSearchOverlay", () => {
  let host: HTMLDivElement | undefined; let root: Root | undefined;
  beforeEach(() => { localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root?.unmount()); host?.remove(); });

  it("groups five results, expands in place, opens a deep link, and closes with Escape", () => {
    const onOpen = vi.fn(); const onClose = vi.fn();
    const trigger = document.createElement("button"); trigger.textContent = "Open Search"; document.body.insertBefore(trigger, host!); trigger.focus();
    act(() => root!.render(<GlobalSearchOverlay open tasks={Array.from({ length: 25 }, (_, index) => item(index))} notes={Array.from({ length: 25 }, (_, index) => item(index, "knowledge-note"))} onOpen={onOpen} onClose={onClose} />));
    const input = document.querySelector<HTMLInputElement>("input[aria-label='Search LifeOS']")!;
    expect(document.activeElement).toBe(input);
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "result"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(document.querySelectorAll("[data-search-group='Tasks'] .global-search-result")).toHaveLength(5);
    expect(document.querySelectorAll("[data-search-group='Notes'] .global-search-result")).toHaveLength(5);
    act(() => (document.querySelector("[data-search-group='Tasks'] button.global-search-more") as HTMLButtonElement).click());
    act(() => (document.querySelector("[data-search-group='Notes'] button.global-search-more") as HTMLButtonElement).click());
    expect(document.querySelectorAll("[data-search-group='Tasks'] .global-search-result")).toHaveLength(20);
    expect(document.querySelectorAll("[data-search-group='Notes'] .global-search-result")).toHaveLength(20);
    const controls = [...document.querySelectorAll<HTMLElement>(".overlay-dialog button, .overlay-dialog input")];
    controls.at(-1)!.focus();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(controls[0]);
    controls[0]!.focus();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(controls.at(-1));
    act(() => (document.querySelector(".global-search-result") as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith({ view: "Tasks", id: expect.any(String) });
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalled();
    act(() => root!.render(<GlobalSearchOverlay open={false} tasks={[]} notes={[]} onOpen={onOpen} onClose={onClose} />));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("shows an explicit offline limit and opens an unnoted Calendar event on its date", () => {
    const onOpen = vi.fn(); const onClose = vi.fn();
    act(() => root!.render(<GlobalSearchOverlay open tasks={[]} notes={[]} calendar={[calendarEvent]} calendarOffline={{ reason: "network", error: "offline" }} onOpen={onOpen} onClose={onClose} />));
    const input = document.querySelector<HTMLInputElement>("input[aria-label='Search LifeOS']")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Roadmap"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(document.querySelector("[data-search-group='Calendar']")?.textContent).toContain("limited to meetings already in LifeOS");
    act(() => (document.querySelector("[data-search-group='Calendar'] .global-search-result") as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith({ view: "Calendar", date: "2026-10-12" });
  });

  it("does not present a failed Calendar search as an empty result", () => {
    act(() => root!.render(<GlobalSearchOverlay open tasks={[]} notes={[]} calendarUnavailable onOpen={vi.fn()} onClose={vi.fn()} />));
    expect(document.querySelector("[data-search-group='Calendar']")?.textContent).toContain("Calendar search is unavailable while LifeOS reconnects");
    expect(document.querySelector("[data-search-group='Calendar']")?.textContent).not.toContain("No calendar found");
  });
});
