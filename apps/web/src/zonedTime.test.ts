import { describe, expect, it } from "vitest";
import { dayRangeQuery } from "./zonedTime.js";

const range = (fromDay: string, toDay: string, timeZone = "Europe/Paris") => {
  const query = new URLSearchParams();
  dayRangeQuery(query, fromDay, toDay, timeZone);
  return Object.fromEntries(query);
};

describe("dayRangeQuery (#116)", () => {
  it("sets nothing when neither day is chosen", () => { expect(range("", "")).toEqual({}); });
  it("sets only from (that day's local midnight) when only the first day is chosen", () => {
    expect(range("2026-07-01", "")).toEqual({ from: "2026-06-30T22:00:00.000Z" });
  });
  it("sets only to (just before the next local midnight) when only the last day is chosen", () => {
    expect(range("", "2026-07-31")).toEqual({ to: "2026-07-31T21:59:59.999Z" });
  });
  it("includes both whole days, also when they are the same day and across a DST change", () => {
    expect(range("2026-07-01", "2026-07-31")).toEqual({ from: "2026-06-30T22:00:00.000Z", to: "2026-07-31T21:59:59.999Z" });
    expect(range("2026-10-25", "2026-10-25")).toEqual({ from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T22:59:59.999Z" });
  });
  it("throws on an unparseable day", () => { expect(() => range("not-a-day", "")).toThrow(RangeError); });
  it("passes from after to through unchanged; the server rejects it", () => {
    expect(range("2026-07-31", "2026-07-01", "UTC")).toEqual({ from: "2026-07-31T00:00:00.000Z", to: "2026-07-01T23:59:59.999Z" });
  });
});
