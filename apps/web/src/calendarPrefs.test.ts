import { describe, expect, it } from "vitest";
import { enabledCalendars, reconcileFilter, resolveDefaultFilter } from "./calendarPrefs.js";

const catalog = [{ id: "work", name: "Work" }, { id: "family", name: "Family" }, { id: "gym", name: "Gym" }];

describe("calendar preferences", () => {
  it("offers every calendar until one is switched off", () => {
    expect(enabledCalendars(catalog, { disabledCalendarIds: [] })).toHaveLength(3);
    expect(enabledCalendars(catalog, { disabledCalendarIds: ["gym"] }).map((calendar) => calendar.id)).toEqual(["work", "family"]);
  });

  it("uses the default calendar when it is enabled and visible", () => {
    const enabled = enabledCalendars(catalog, { disabledCalendarIds: [] });
    expect(resolveDefaultFilter(enabled, { disabledCalendarIds: [], defaultCalendarId: "family" })).toBe("family");
  });

  it("falls back to all calendars when the default is unset, disabled, or no longer visible", () => {
    expect(resolveDefaultFilter(enabledCalendars(catalog, { disabledCalendarIds: [] }), { disabledCalendarIds: [] })).toBe("all");
    expect(resolveDefaultFilter(enabledCalendars(catalog, { disabledCalendarIds: ["family"] }), { disabledCalendarIds: ["family"], defaultCalendarId: "family" })).toBe("all");
    expect(resolveDefaultFilter(enabledCalendars(catalog, { disabledCalendarIds: [] }), { disabledCalendarIds: [], defaultCalendarId: "deleted" })).toBe("all");
    expect(resolveDefaultFilter([], { disabledCalendarIds: [], defaultCalendarId: "work" })).toBe("all");
  });

  it("drops a selection that is no longer offered", () => {
    const enabled = enabledCalendars(catalog, { disabledCalendarIds: ["gym"] });
    expect(reconcileFilter("gym", enabled)).toBe("all");
    expect(reconcileFilter("work", enabled)).toBe("work");
    expect(reconcileFilter("all", enabled)).toBe("all");
  });
});
