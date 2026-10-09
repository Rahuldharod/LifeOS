import { describe, expect, it } from "vitest";
import { activeNoteFilterCount, describeNoteFilters, emptyNotesMessage, noNoteFilters, noteListQuery } from "./noteFilters.js";

describe("note list filters", () => {
  it("sends only state and keyword when no filter is set", () => {
    expect(noteListQuery("open", "", noNoteFilters, "UTC")).toBe("state=open");
    expect(noteListQuery("deleted", " roadmap ", noNoteFilters, "UTC")).toBe("state=deleted&q=roadmap");
  });
  it("repeats type and sends each link under the Decisions parameter names", () => {
    const query = new URLSearchParams(noteListQuery("open", "", { ...noNoteFilters, types: ["meeting-note", "knowledge-note"], projectId: "p", clientId: "c", productId: "x", personId: "u" }, "UTC"));
    expect(query.getAll("type")).toEqual(["meeting-note", "knowledge-note"]);
    expect([query.get("projectId"), query.get("clientId"), query.get("productId"), query.get("personId")]).toEqual(["p", "c", "x", "u"]);
  });
  it("turns local days into an inclusive instant range in the display timezone", () => {
    const query = new URLSearchParams(noteListQuery("open", "", { ...noNoteFilters, fromDay: "2026-07-01", toDay: "2026-07-31" }, "Europe/Paris"));
    expect(query.get("from")).toBe("2026-06-30T22:00:00.000Z");
    expect(query.get("to")).toBe("2026-07-31T21:59:59.999Z");
  });
  it("counts one per active control: type once, the date range once, never the keyword", () => {
    expect(activeNoteFilterCount(noNoteFilters)).toBe(0);
    expect(activeNoteFilterCount({ ...noNoteFilters, types: ["meeting-note", "knowledge-note"], fromDay: "2026-07-01", toDay: "2026-07-02", personId: "u" })).toBe(3);
    expect(activeNoteFilterCount({ ...noNoteFilters, toDay: "2026-07-02" })).toBe(1);
  });
  it("explains an empty list by keyword, filters and the meeting-notes-only rule", () => {
    expect(emptyNotesMessage("open", "", noNoteFilters)).toBe("No notes have been created yet.");
    expect(emptyNotesMessage("deleted", "", noNoteFilters)).toBe("No deleted notes.");
    expect(emptyNotesMessage("open", "roadmap", noNoteFilters)).toBe("No open notes match “roadmap”.");
    expect(emptyNotesMessage("open", "", { ...noNoteFilters, types: ["meeting-note"] })).toBe("No open notes match these filters: Type.");
    expect(emptyNotesMessage("deleted", "x", { ...noNoteFilters, personId: "u", fromDay: "2026-07-01" }))
      .toBe("No deleted notes match “x” with these filters: Person, Deleted. Project, client, product and person only match meeting notes.");
  });
  it("names the active filters and flags the meeting-notes-only rule", () => {
    expect(describeNoteFilters(noNoteFilters, "open")).toEqual({ labels: [], meetingOnlyRule: false });
    const described = describeNoteFilters({ ...noNoteFilters, types: ["knowledge-note"], projectId: "p", fromDay: "2026-07-01" }, "deleted");
    expect(described.labels).toEqual(["Type", "Project", "Deleted"]);
    expect(described.meetingOnlyRule).toBe(true);
    expect(describeNoteFilters({ ...noNoteFilters, toDay: "2026-07-01" }, "open")).toEqual({ labels: ["Last edited"], meetingOnlyRule: false });
  });
});
