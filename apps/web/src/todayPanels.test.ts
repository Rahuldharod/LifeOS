import { describe, expect, it } from "vitest";
import { awaitingAdoptionLabel, daysBetween, panelRowLimit, visibleRows } from "./todayPanels.js";

describe("Today live panels (#48)", () => {
  it("shows at most 6 rows before 'show more', within the 5–7 row rule", () => {
    expect(panelRowLimit).toBeGreaterThanOrEqual(5);
    expect(panelRowLimit).toBeLessThanOrEqual(7);
    const items = Array.from({ length: 10 }, (_, index) => index);
    expect(visibleRows(items, false)).toEqual({ rows: [0, 1, 2, 3, 4, 5], hidden: 4 });
    expect(visibleRows(items, true)).toEqual({ rows: items, hidden: 0 });
  });

  it("never hides a single row behind 'show more', and never shows more than 7 collapsed", () => {
    expect(visibleRows([1, 2, 3, 4, 5, 6, 7], false)).toEqual({ rows: [1, 2, 3, 4, 5, 6, 7], hidden: 0 });
    expect(visibleRows([1, 2, 3, 4, 5, 6, 7, 8], false).rows).toHaveLength(6);
    expect(visibleRows([], false)).toEqual({ rows: [], hidden: 0 });
  });

  it("words the adoption count accurately: patches are not called drafts", () => {
    expect(awaitingAdoptionLabel({ awaiting: 3, drafts: 2, patches: 1 })).toBe("2 drafts and 1 patch awaiting adoption");
    expect(awaitingAdoptionLabel({ awaiting: 1, drafts: 1, patches: 0 })).toBe("1 draft awaiting adoption");
    expect(awaitingAdoptionLabel({ awaiting: 2, drafts: 0, patches: 2 })).toBe("2 patches awaiting adoption");
    expect(awaitingAdoptionLabel({ awaiting: 0, drafts: 0, patches: 0 })).toBe("Nothing awaiting adoption");
  });

  it("counts whole days between local dates", () => {
    expect(daysBetween("2026-10-01", "2026-10-05")).toBe(4);
    expect(daysBetween("2026-10-05", "2026-10-05")).toBe(0);
  });
});
