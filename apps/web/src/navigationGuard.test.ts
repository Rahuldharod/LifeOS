import { describe, expect, it } from "vitest";
import { needsSaveBeforeLeaving, saveBeforeLeaving, settleBlockedNavigation } from "./navigationGuard.js";

const editor = (state: { dirty?: boolean; conflict?: boolean; saves?: boolean } = {}) => {
  const calls: string[] = [];
  return { calls, dirty: state.dirty ?? false, conflict: state.conflict ?? false, saveNow: async () => { calls.push("save"); return state.saves ?? true; } };
};
const blocker = () => {
  const calls: string[] = [];
  return { calls, proceed: () => calls.push("proceed"), reset: () => calls.push("reset") };
};

describe("save before navigating (PB-027)", () => {
  it("lets a clean page go without saving", async () => {
    const notes = editor();
    expect(needsSaveBeforeLeaving([notes], false)).toBe(false);
    expect(await saveBeforeLeaving([notes], false)).toBe(true);
    expect(notes.calls).toEqual([]);
  });

  it("saves unsaved edits first, then lets the navigation go", async () => {
    const notes = editor({ dirty: true });
    const navigation = blocker();
    expect(needsSaveBeforeLeaving([notes], false)).toBe(true);
    await settleBlockedNavigation(navigation, () => saveBeforeLeaving([notes], false), () => navigation.calls.push("message"));
    expect(notes.calls).toEqual(["save"]);
    expect(navigation.calls).toEqual(["proceed"]);
  });

  it("stays on the page when the save fails", async () => {
    const notes = editor({ dirty: true, saves: false });
    const meeting = editor({ dirty: true });
    const navigation = blocker();
    await settleBlockedNavigation(navigation, () => saveBeforeLeaving([notes, meeting], false), () => navigation.calls.push("message"));
    expect(navigation.calls).toEqual(["reset", "message"]);
    expect(meeting.calls).toEqual([]);
  });

  it("stays on the page when the save throws", async () => {
    const navigation = blocker();
    await settleBlockedNavigation(navigation, async () => { throw new Error("offline"); }, () => navigation.calls.push("message"));
    expect(navigation.calls).toEqual(["reset", "message"]);
  });

  it("does not trap the user when nothing could save: a conflict or read-only draft stays in the browser", () => {
    expect(needsSaveBeforeLeaving([editor({ dirty: true, conflict: true })], false)).toBe(false);
    expect(needsSaveBeforeLeaving([editor({ dirty: true })], true)).toBe(false);
  });
});
