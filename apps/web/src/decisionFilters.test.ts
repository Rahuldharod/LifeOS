import { describe, expect, it } from "vitest";
import { decisionQuery, noDecisionFilters } from "./decisionFilters.js";
import { zonedDateTime, zonedInputValue } from "./zonedTime.js";

describe("decision filters", () => {
  it("sends only the filters that are set", () => {
    expect(decisionQuery(noDecisionFilters, "Europe/Paris")).toBe("");
    expect(decisionQuery({ ...noDecisionFilters, projectId: "p", status: "active" }, "UTC")).toBe("projectId=p&status=active");
  });
  it("turns local days into an inclusive instant range in the display timezone", () => {
    const query = new URLSearchParams(decisionQuery({ ...noDecisionFilters, fromDay: "2026-07-01", toDay: "2026-07-31" }, "Europe/Paris"));
    expect(query.get("from")).toBe("2026-06-30T22:00:00.000Z");
    expect(query.get("to")).toBe("2026-07-31T21:59:59.999Z");
  });
  it("round-trips a datetime-local value through the display timezone", () => {
    const instant = zonedDateTime("2026-01-15", "09:30", "Europe/Paris").toISOString();
    expect(instant).toBe("2026-01-15T08:30:00.000Z");
    expect(zonedInputValue(instant, "Europe/Paris")).toBe("2026-01-15T09:30");
  });
});
