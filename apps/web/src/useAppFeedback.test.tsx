// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("./api.js", () => ({ api: (...args: unknown[]) => api(...args) }));
const { useAppFeedback } = await import("./FeedbackDialog.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useAppFeedback>;
const id = "0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

function Probe({ openObjectId, known }: { openObjectId?: string; known: string[] }) {
  current = useAppFeedback({ page: "Tasks", openObjectId, knownObjectIds: known });
  return null;
}

beforeEach(() => { vi.useFakeTimers(); api.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

describe("useAppFeedback", () => {
  it("opens and closes the dialog", () => {
    act(() => root!.render(<Probe known={[]} />));
    expect(current.dialog.open).toBe(false);
    act(() => current.open());
    expect(current.dialog.open).toBe(true);
    act(() => current.dialog.onClose());
    expect(current.dialog.open).toBe(false);
  });

  it("gives the object link only when the open item is a loaded object", () => {
    act(() => root!.render(<Probe openObjectId={id} known={[id]} />));
    expect(current.dialog.object).toBe(`lifeos://object/${id}`);
    act(() => root!.render(<Probe openObjectId={id} known={[]} />));
    expect(current.dialog.object).toBeUndefined();
  });

  it("posts the request, shows the toast, and clears it after 4 seconds", async () => {
    api.mockResolvedValue({ message: "Feedback saved" });
    act(() => root!.render(<Probe known={[]} />));
    await act(async () => current.dialog.onSend({ label: "bug", text: "x", page: "Tasks" }));
    expect(api).toHaveBeenCalledWith("POST /api/v1/feedback", { body: { label: "bug", text: "x", page: "Tasks" } });
    expect(current.toast).toBe("Feedback saved");
    act(() => { vi.advanceTimersByTime(4000); });
    expect(current.toast).toBe("");
  });

  it("shows no toast and rethrows when the save fails", async () => {
    api.mockRejectedValue(new Error("disk full"));
    act(() => root!.render(<Probe known={[]} />));
    await expect(act(async () => current.dialog.onSend({ label: "bug", text: "x", page: "Tasks" }))).rejects.toThrow("disk full");
    expect(current.toast).toBe("");
  });
});
