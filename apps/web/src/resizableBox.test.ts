import { describe, expect, it } from "vitest";
import { clampBoxSize } from "./resizableBox.js";

describe("notes editor resize (PB-024 follow-up)", () => {
  it("keeps the editor between its minimum size and the column width", () => {
    expect(clampBoxSize({ width: 900, height: 700 }, 1200)).toEqual({ width: 900, height: 700 });
    expect(clampBoxSize({ width: 100, height: 50 }, 1200)).toEqual({ width: 360, height: 280 });
    expect(clampBoxSize({ width: 2000, height: 3000 }, 1200)).toEqual({ width: 1200, height: 3000 });
  });
});

describe("feedback popup limits", () => {
  const limits = { minWidth: 360, minHeight: 360, maxHeight: 500 };
  it("uses its own minimum and never grows taller than the window room", () => {
    expect(clampBoxSize({ width: 100, height: 100 }, 1200, limits)).toEqual({ width: 360, height: 360 });
    expect(clampBoxSize({ width: 800, height: 900 }, 1200, limits)).toEqual({ width: 800, height: 500 });
  });
  it("keeps the minimum when the window is smaller than it", () => {
    expect(clampBoxSize({ width: 800, height: 900 }, 300, { ...limits, maxHeight: 200 })).toEqual({ width: 360, height: 360 });
  });
});
