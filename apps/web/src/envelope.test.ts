import { describe, expect, it } from "vitest";
import { isRestricted, originLabel } from "./envelope.js";

describe("envelope display", () => {
  it("reads a missing origin as the LifeOS app and names known origins", () => {
    expect(originLabel({})).toBe("LifeOS app");
    expect(originLabel({ origin: "calendar" })).toBe("Calendar");
    expect(originLabel({ origin: "something-new" })).toBe("something-new");
  });

  it("treats only restricted as restricted", () => {
    expect(isRestricted({})).toBe(false);
    expect(isRestricted({ sensitivity: "normal" })).toBe(false);
    expect(isRestricted({ sensitivity: "restricted" })).toBe(true);
  });
});
