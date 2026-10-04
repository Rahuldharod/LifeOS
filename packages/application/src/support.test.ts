import { describe, expect, it } from "vitest";
import type { LifeOSObject } from "@lifeos/domain";
import { contextLinkFields, dueDate, inheritContextLinks, isLive, isMeetingRestricted, isRestricted, isStringList, objectIdPattern, OneAtATime, replayableId, replayRoles, replayScope, sameValue, stringsIn, validTimeZone } from "./support.js";

const object = (frontmatter: Record<string, unknown>) => ({ frontmatter, body: "" }) as unknown as LifeOSObject;

describe("isRestricted (ADR 0010)", () => {
  it("is true only for sensitivity: restricted; missing means normal", () => {
    expect(isRestricted(object({ sensitivity: "restricted" }))).toBe(true);
    expect(isRestricted(object({ sensitivity: "normal" }))).toBe(false);
    expect(isRestricted(object({}))).toBe(false);
    expect(isRestricted(object({ sensitivity: null }))).toBe(false);
  });
  it("treats no object as not restricted", () => { expect(isRestricted(undefined)).toBe(false); });
});

describe("isMeetingRestricted (ADR 0010, #63)", () => {
  const meeting = (extra: Record<string, unknown> = {}) => object({ id: "m1", type: "meeting", ...extra });
  const note = (extra: Record<string, unknown> = {}) => object({ id: "n1", type: "meeting-note", meeting_id: "m1", ...extra });
  it("is true when the meeting is restricted", () => { expect(isMeetingRestricted(meeting({ sensitivity: "restricted" }), [])).toBe(true); });
  it("is true when the meeting's note is restricted", () => { expect(isMeetingRestricted(meeting(), [note({ sensitivity: "restricted" })])).toBe(true); });
  it("ignores restricted notes of other meetings, deleted notes and non-notes", () => {
    expect(isMeetingRestricted(meeting(), [note({ meeting_id: "m2", sensitivity: "restricted" })])).toBe(false);
    expect(isMeetingRestricted(meeting(), [note({ sensitivity: "restricted", deleted_at: "2026-10-01T00:00:00.000Z" })])).toBe(false);
    expect(isMeetingRestricted(meeting(), [object({ type: "task", meeting_id: "m1", sensitivity: "restricted" })])).toBe(false);
  });
  it("is false for a normal meeting with a normal note, and for no meeting", () => {
    expect(isMeetingRestricted(meeting(), [note()])).toBe(false);
    expect(isMeetingRestricted(undefined, [note({ sensitivity: "restricted" })])).toBe(false);
  });
});

describe("isLive", () => {
  it("is false once deleted or archived", () => {
    expect(isLive(object({}))).toBe(true);
    expect(isLive(object({ deleted_at: "2026-10-01T00:00:00.000Z" }))).toBe(false);
    expect(isLive(object({ archived_at: "2026-10-01T00:00:00.000Z" }))).toBe(false);
  });
});

describe("sameValue: null and undefined both mean 'absent'", () => {
  it("treats null and undefined as equal to each other", () => {
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(undefined, undefined)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
  });
  it("never treats absent as equal to a falsy value", () => {
    expect(sameValue(undefined, "")).toBe(false);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue(null, false)).toBe(false);
    expect(sameValue(undefined, [])).toBe(false);
  });
  it("compares values structurally", () => {
    expect(sameValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameValue("1", 1)).toBe(false);
  });
});

describe("context links", () => {
  it("lists the primary project, client and product", () => {
    expect([...contextLinkFields]).toEqual(["primary_project_id", "primary_client_id", "primary_product_id"]);
  });
  it("inherits only the meeting's text context links", () => {
    const meeting = object({ primary_project_id: "p", primary_client_id: 7, primary_product_id: "q", people_ids: ["x"] });
    expect(inheritContextLinks(meeting)).toEqual({ primary_project_id: "p", primary_product_id: "q" });
    expect(inheritContextLinks(undefined)).toEqual({});
  });
});

describe("small value helpers", () => {
  it("objectIdPattern matches a UUID in any case", () => {
    expect(objectIdPattern.test("0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b")).toBe(true);
    expect(objectIdPattern.test("0192A3B4-C5D6-7E8F-9A0B-1C2D3E4F5A6B")).toBe(true);
    expect(objectIdPattern.test("Project Alpha")).toBe(false);
  });
  it("validTimeZone accepts IANA names only", () => {
    expect(validTimeZone("Europe/Paris")).toBe(true);
    expect(validTimeZone("Mars/Olympus")).toBe(false);
  });
  it("dueDate prefers due_on, else the date part of due_at", () => {
    expect(dueDate(object({ due_on: "2026-10-04", due_at: "2026-10-09T10:00:00Z" }))).toBe("2026-10-04");
    expect(dueDate(object({ due_at: "2026-10-09T10:00:00Z" }))).toBe("2026-10-09");
    expect(dueDate(object({}))).toBeUndefined();
  });
  it("isStringList is a predicate; stringsIn keeps the text items", () => {
    expect(isStringList(["a", "b"])).toBe(true);
    expect(isStringList(["a", 1])).toBe(false);
    expect(isStringList("a")).toBe(false);
    expect(stringsIn(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(stringsIn("a")).toEqual([]);
  });
});

describe("replayable IDs and role keys (#59, #74)", () => {
  const seed = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
  const now = "2026-10-04T09:15:00.000Z";
  it("builds the same role text as before #74, so in-flight operations replay onto the same IDs", () => {
    const merge = replayRoles.within(replayRoles.main, replayRoles.merge("a|b"));
    expect(merge).toBe("main/merge:a|b");
    expect(replayRoles.operation(merge)).toBe("main/merge:a|b:operation");
    expect(replayRoles.within(replayRoles.main, replayRoles.urlSource("https://example.com/x"))).toBe("main/source:url:https://example.com/x");
    expect(replayRoles.within(replayRoles.main, replayRoles.bodySource)).toBe("main/source:body");
    expect(replayRoles.source("gong", "g-1")).toBe("source:gong:g-1");
    expect(replayRoles.proposal("p1")).toBe("proposal:p1");
    expect(replayRoles.link("owner", "Kim")).toBe("link:owner:Kim");
    expect(replayRoles.operation(replayRoles.review)).toBe("review:operation");
  });
  it("derives the same IDs as before #74", () => {
    expect(replayableId(seed, replayRoles.main, now)).toBe("01a10631-f620-7492-a192-48fc12b01ad5");
    expect(replayableId(seed, replayRoles.within(replayRoles.main, replayRoles.merge("a|b")), now)).toBe("01a10631-f620-7492-a192-947f1f5ebd91");
    expect(replayableId(seed, replayRoles.operation(replayRoles.within(replayRoles.main, replayRoles.merge("a|b"))), now)).toBe("01a10631-f620-7492-a192-04ecfae6c878");
  });
  it("scopes a replay to every ID of its own operation and no other", () => {
    const scope = replayScope(seed, now);
    expect(scope(replayableId(seed, replayRoles.summary, now))).toBe(true);
    expect(scope(replayableId(seed, replayRoles.proposal("x"), now))).toBe(true);
    expect(scope(replayableId("01995d3e-912b-7357-8aa6-9816c1ad90a6", replayRoles.main, now))).toBe(false);
    expect(scope("01a10631-f620-7492-a192")).toBe(false);
  });
});

describe("OneAtATime (#74)", () => {
  it("runs calls with one key one after the other, even after a failure, and calls with other keys alongside", async () => {
    const queue = new OneAtATime();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("a", async () => { log.push("a1 start"); await gate; log.push("a1 end"); throw new Error("a1 failed"); });
    const second = queue.run("a", async () => { log.push("a2"); return 2; });
    const other = queue.run("b", async () => { log.push("b1"); return 1; });
    await other;
    expect(log).toEqual(["a1 start", "b1"]);
    release();
    await expect(first).rejects.toThrow("a1 failed");
    expect(await second).toBe(2);
    expect(log).toEqual(["a1 start", "b1", "a1 end", "a2"]);
  });
});
