// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { inboxViewStorageKey, readInboxView } from "./useInboxView.js";

describe("remembered Inbox view (#240)", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Split and reads back List", () => {
    expect(readInboxView()).toBe("split");
    localStorage.setItem(inboxViewStorageKey, "list");
    expect(readInboxView()).toBe("list");
  });

  it("ignores junk", () => {
    localStorage.setItem(inboxViewStorageKey, "wide");
    expect(readInboxView()).toBe("split");
  });
});
