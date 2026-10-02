import { describe, expect, it } from "vitest";
import { clampSplitWidth } from "./splitPane.js";

describe("split pane width (PB-024)", () => {
  it("keeps a dragged width between 260px and 60% of the layout", () => {
    expect(clampSplitWidth(400, 1600)).toBe(400);
    expect(clampSplitWidth(100, 1600)).toBe(260);
    expect(clampSplitWidth(1400, 1600)).toBe(960);
    expect(clampSplitWidth(300, 300)).toBe(260); // never below the minimum, even on a tiny layout
  });
});
