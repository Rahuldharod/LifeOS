import { describe, expect, it } from "vitest";
import { noteSeriesRoute } from "./noteSeriesLink.js";

const meeting = (id: string, startsAt: string, series?: string) => ({ frontmatter: { id, type: "meeting", title: "M", starts_at: startsAt, ...(series ? { recurrence_series_id: series } : {}) } });
const note = (fields: Record<string, unknown>) => ({ frontmatter: { id: "n", type: "meeting-note", title: "N", ...fields } });

describe("noteSeriesRoute", () => {
  const objects = [meeting("m1", "2026-09-07T08:00:00Z", "s"), meeting("m2", "2026-09-14T08:00:00Z", "s"), meeting("solo", "2026-09-14T08:00:00Z")];
  it("targets the Meeting of a per-occurrence Note in a recurring series", () => {
    expect(noteSeriesRoute(note({ meeting_id: "m1" }), objects, "Europe/Paris")).toEqual({ view: "Calendar", date: "2026-09-07", id: "m1" });
  });
  it("targets the newest linked Meeting of a Legacy shared Note", () => {
    expect(noteSeriesRoute(note({ meeting_id: "m1", meeting_ids: ["m1", "m2"] }), objects, "Europe/Paris")).toEqual({ view: "Calendar", date: "2026-09-14", id: "m2" });
  });
  it("uses the display time zone for the day", () => {
    expect(noteSeriesRoute(note({ meeting_id: "m1" }), [meeting("m1", "2026-09-07T23:30:00Z", "s")], "Europe/Paris")?.date).toBe("2026-09-08");
  });
  it("returns nothing for non-recurring, unlinked or missing Meetings", () => {
    expect(noteSeriesRoute(note({ meeting_id: "solo" }), objects, "Europe/Paris")).toBeUndefined();
    expect(noteSeriesRoute(note({}), objects, "Europe/Paris")).toBeUndefined();
    expect(noteSeriesRoute(note({ meeting_id: "gone" }), objects, "Europe/Paris")).toBeUndefined();
  });
});
