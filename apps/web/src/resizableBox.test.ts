import { describe, expect, it } from "vitest";
import { clampBoxSize } from "./resizableBox.js";

describe("notes editor resize (PB-024 follow-up)", () => {
  it("keeps the editor between its minimum size and the column width", () => {
    expect(clampBoxSize({ width: 900, height: 700 }, 1200)).toEqual({ width: 900, height: 700 });
    expect(clampBoxSize({ width: 100, height: 50 }, 1200)).toEqual({ width: 360, height: 280 });
    expect(clampBoxSize({ width: 2000, height: 3000 }, 1200)).toEqual({ width: 1200, height: 3000 });
  });
});
