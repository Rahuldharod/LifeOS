import { describe, expect, it } from "vitest";
import { dayKey, dayLabel, groupByDay } from "./noteGroups.js";

const now = new Date("2026-10-02T15:00:00.000Z"); // Friday 2 October 2026, 17:00 in Paris

describe("Latest notes day groups (PB-023)", () => {
  it("labels today, yesterday, older days this year and other years", () => {
    expect(dayLabel("2026-10-02", "Europe/Paris", now)).toBe("Today");
    expect(dayLabel("2026-10-01", "Europe/Paris", now)).toBe("Yesterday");
    expect(dayLabel("2026-09-28", "Europe/Paris", now)).toBe("Monday 28 September");
    expect(dayLabel("2025-12-29", "Europe/Paris", now)).toBe("Monday 29 December 2025");
  });

  it("uses the display timezone for the day boundary", () => {
    // 23:30 UTC on 1 October is already 2 October in Paris.
    expect(dayKey("2026-10-01T23:30:00.000Z", "Europe/Paris")).toBe("2026-10-02");
    expect(dayKey("2026-10-01T23:30:00.000Z", "UTC")).toBe("2026-10-01");
  });

  it("handles yesterday across a month boundary", () => {
    expect(dayLabel("2026-09-30", "Europe/Paris", new Date("2026-10-01T10:00:00.000Z"))).toBe("Yesterday");
  });

  it("groups a newest-first list into consecutive days, keeping order", () => {
    const notes = [
      { id: "a", at: "2026-10-02T14:00:00.000Z" },
      { id: "b", at: "2026-10-02T08:00:00.000Z" },
      { id: "c", at: "2026-10-01T09:00:00.000Z" },
      { id: "d", at: "2026-09-21T07:00:00.000Z" }
    ];
    const groups = groupByDay(notes, (note) => note.at, "Europe/Paris", now);
    expect(groups.map((group) => [group.label, group.items.map((note) => note.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Monday 21 September", ["d"]]
    ]);
  });
});
