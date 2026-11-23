// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxToast, useInboxToast } from "./InboxToast.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.useRealTimers(); });

let api: ReturnType<typeof useInboxToast>;
function Harness() {
  api = useInboxToast();
  return <InboxToast toast={api.toast} held={api.held} onHold={api.hold} onRelease={api.release} />;
}
const text = () => document.querySelector(".inbox-toast")?.textContent ?? "";
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("Inbox toast timer", () => {
  it("a message that arrives while the toast is held waits until it is released", async () => {
    vi.useFakeTimers();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness />));
    const undo = [{ id: "undo", label: "Undo", run: () => undefined }];
    await act(async () => api.notify("First", undo));
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-toast-action='undo']")!.focus(); });
    await act(async () => api.notify("Second", undo)); // the same Undo button stays, and keeps focus
    await advance(20_000);
    expect(text()).toContain("Second"); // still there while the user is on it
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-toast-action='undo']")!.blur(); });
    await advance(7_900);
    expect(text()).toContain("Second");
    await advance(200);
    expect(text()).toBe("");
  });

  it("a hold is let go when the focused button is replaced without a blur (Enter on Undo)", async () => {
    vi.useFakeTimers();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness />));
    await act(async () => api.notify("1 proposal rejected", [{ id: "undo", label: "Undo", run: () => undefined }]));
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-toast-action='undo']")!.focus(); });
    await act(async () => api.notify("1 proposal back in the Inbox")); // the Undo button is gone
    await advance(3_100);
    expect(text()).toBe("");
    await act(async () => api.notify("Next message"));
    await advance(3_100);
    expect(text()).toBe(""); // later toasts time out too
  });

  it("without a hold, a message goes after 3 seconds", async () => {
    vi.useFakeTimers();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness />));
    await act(async () => api.notify("Plain"));
    await advance(2_900);
    expect(text()).toBe("Plain");
    await advance(200);
    expect(text()).toBe("");
  });
});
