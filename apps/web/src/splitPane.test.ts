// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readStoredWidth, splitStorageKey } from "./splitPane.js";

describe("remembered list width (PB-024, #154)", () => {
  beforeEach(() => localStorage.clear());

  it("is remembered per workspace and keeps the earlier Notes and Calendar keys", () => {
    expect(splitStorageKey("notes")).toBe("lifeos.notesSplitWidth");
    expect(splitStorageKey("calendar")).toBe("lifeos.split.calendar");
    expect(splitStorageKey("tasks")).toBe("lifeos.split.tasks");
  });

  it("clamps a stored width into the workspace's bounds and ignores junk", () => {
    localStorage.setItem("lifeos.split.tasks", "900");
    expect(readStoredWidth("tasks")).toBe(640);
    localStorage.setItem("lifeos.split.calendar", "100");
    expect(readStoredWidth("calendar")).toBe(320);
    localStorage.setItem("lifeos.notesSplitWidth", "wide");
    expect(readStoredWidth("notes")).toBeUndefined();
    expect(readStoredWidth("inbox")).toBeUndefined();
  });

  it("does not cap a remembered Inbox width, but still raises one under its minimum (#240)", () => {
    localStorage.setItem("lifeos.split.inbox", "1400");
    expect(readStoredWidth("inbox")).toBe(1400);
    localStorage.setItem("lifeos.split.inbox", "200");
    expect(readStoredWidth("inbox")).toBe(380);
  });
});
