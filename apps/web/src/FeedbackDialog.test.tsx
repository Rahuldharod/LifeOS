// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackDialog, type FeedbackRequest } from "./FeedbackDialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

function Harness({ onSend, object }: { onSend: (request: FeedbackRequest) => Promise<void>; object?: string }) {
  const [open, setOpen] = useState(true);
  return <><span data-testid="state">{open ? "open" : "closed"}</span><FeedbackDialog open={open} page="Notes" object={object} onClose={() => setOpen(false)} onSend={onSend} /></>;
}

const textarea = () => document.querySelector<HTMLTextAreaElement>(".feedback-text")!;
const sendButton = () => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Send") && candidate.type === "submit")!;
const type = (text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text);
  textarea().dispatchEvent(new Event("input", { bubbles: true }));
});
const state = () => document.querySelector("[data-testid=state]")!.textContent;

describe("FeedbackDialog", () => {
  it("disables Send while the text is empty and defaults to Feature", () => {
    act(() => root!.render(<Harness onSend={vi.fn()} />));
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("input[value=feature]")!.checked).toBe(true);
    type("   ");
    expect(sendButton().disabled).toBe(true);
    type("Hello");
    expect(sendButton().disabled).toBe(false);
  });

  it("sends the text as typed with the label, page and object, then closes", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const object = "lifeos://object/0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    act(() => root!.render(<Harness onSend={onSend} object={object} />));
    type("  Broken save\n");
    act(() => document.querySelector<HTMLInputElement>("input[value=bug]")!.click());
    await act(async () => sendButton().click());
    expect(onSend).toHaveBeenCalledWith({ label: "bug", text: "  Broken save\n", page: "Notes", object });
    expect(state()).toBe("closed");
  });

  it("leaves the object out when none is open", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    act(() => root!.render(<Harness onSend={onSend} />));
    type("Idea");
    await act(async () => sendButton().click());
    expect(onSend.mock.calls[0]![0]).toEqual({ label: "feature", text: "Idea", page: "Notes" });
  });

  it("stays open with the text and shows the error when saving fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("Could not save feedback: disk full"));
    act(() => root!.render(<Harness onSend={onSend} />));
    type("Keep me");
    await act(async () => sendButton().click());
    expect(state()).toBe("open");
    expect(textarea().value).toBe("Keep me");
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Could not save feedback: disk full");
    expect(sendButton().disabled).toBe(false);
  });

  it("closes on Escape", () => {
    act(() => root!.render(<Harness onSend={vi.fn()} />));
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(state()).toBe("closed");
  });
});
