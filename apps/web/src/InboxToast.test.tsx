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
  return <InboxToast toast={api.toast} onHold={api.hold} onRelease={api.release} />;
}
const text = () => document.querySelector(".inbox-toast")?.textContent ?? "";
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("Inbox toast timer", () => {
  it("a message that arrives while the toast is held waits until it is released", async () => {
    vi.useFakeTimers();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness />));
    await act(async () => api.notify("First"));
    await act(async () => document.querySelector(".inbox-toast")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(async () => { api.hold(); });
    await act(async () => api.notify("Second"));
    await advance(20_000);
    expect(text()).toBe("Second"); // still there under the cursor
    await act(async () => { api.release(); });
    await advance(2_900);
    expect(text()).toBe("Second");
    await advance(200);
    expect(text()).toBe("");
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
