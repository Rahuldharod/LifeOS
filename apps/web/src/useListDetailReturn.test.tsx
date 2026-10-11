// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useListDetailReturn } from "./useListDetailReturn.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Workspace({ initial }: { initial?: string }) {
  const [selected, setSelected] = useState<string | undefined>(initial);
  const ref = useListDetailReturn(selected);
  return <div ref={ref}>
    <section data-pane="list" hidden={Boolean(selected)}>{["One", "Two", "Three"].map((name) => <button key={name} aria-label={`Open ${name}`} onClick={() => setSelected(name)}>{name}</button>)}</section>
    <section data-pane="detail" hidden={!selected}>{selected && <><button onClick={() => setSelected(undefined)}>Back</button><h2>{selected}</h2></>}</section>
  </div>;
}

describe("list/detail focus continuity (#154)", () => {
  it("moves focus to the detail heading, then Back restores the originating row and list scroll", () => {
    act(() => root.render(<Workspace />));
    const list = host.querySelector<HTMLElement>("[data-pane='list']")!;
    list.scrollTop = 120; list.dispatchEvent(new Event("scroll"));
    const two = host.querySelector<HTMLButtonElement>("[aria-label='Open Two']")!;
    two.focus(); act(() => two.click());
    expect(document.activeElement?.textContent).toBe("Two");
    expect(document.activeElement?.tagName).toBe("H2");
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "Back")!.click());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open Two");
    expect(list.scrollTop).toBe(120);
  });

  it("does not steal focus when a record opens from a direct link", () => {
    act(() => root.render(<Workspace initial="Three" />));
    expect(document.activeElement).toBe(document.body);
  });
});
