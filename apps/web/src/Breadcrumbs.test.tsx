// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs.js";
import type { Crumb } from "./trail.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

const trail: Crumb[] = [
  { label: "Calendar", route: { view: "Calendar" } },
  { label: "3 Oct", route: { view: "Calendar", date: "2026-10-03" } },
  { label: "Weekly sync" }
];

function render(crumbs: Crumb[], go = vi.fn()) {
  const host = document.createElement("div");
  root = createRoot(host);
  act(() => root!.render(<Breadcrumbs trail={crumbs} onGo={go} />));
  return { host, go };
}
const click = (element: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => { element.dispatchEvent(event); });
  return event;
};

describe("Breadcrumbs (PB-026)", () => {
  it("renders an accessible trail: links for all but the last crumb, which is the current page", () => {
    const { host } = render(trail);
    const nav = host.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Breadcrumb");
    expect(nav.querySelectorAll("ol > li")).toHaveLength(3);
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/calendar", "/calendar/2026-10-03"]);
    const last = nav.querySelector("[aria-current='page']")!;
    expect(last.textContent).toBe("Weekly sync");
    expect(last.tagName).not.toBe("A");
    expect(last.getAttribute("title")).toBe("Weekly sync");
  });

  it("renders nothing without a trail", () => {
    expect(render([]).host.innerHTML).toBe("");
  });

  it("a plain click goes through go() instead of reloading the page", () => {
    const { host, go } = render(trail);
    const event = click(host.querySelectorAll("a")[1]!);
    expect(event.defaultPrevented).toBe(true);
    expect(go).toHaveBeenCalledWith({ view: "Calendar", date: "2026-10-03" });
  });

  it.each([["ctrl", { ctrlKey: true }], ["meta", { metaKey: true }], ["shift", { shiftKey: true }], ["middle button", { button: 1 }]])("%s-click keeps the browser default", (_name, init) => {
    const { host, go } = render(trail);
    const event = click(host.querySelector("a")!, init);
    expect(event.defaultPrevented).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
