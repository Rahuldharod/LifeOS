import { describe, expect, it } from "vitest";
import { parseRoute, routePath, routeTarget } from "./routes.js";

const NOTE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MEETING = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("routes (PB-027)", () => {
  it("gives every tab its own path", () => {
    expect(parseRoute("/today")).toEqual({ view: "Today" });
    expect(parseRoute("/open-points")).toEqual({ view: "Open Points" });
    expect(parseRoute("/settings")).toEqual({ view: "Settings" });
    expect(routePath({ view: "Open Points" })).toBe("/open-points");
    expect(routePath({ view: "Inbox" })).toBe("/inbox");
  });

  it("opens a note, a deleted note and an item by id", () => {
    expect(parseRoute(`/notes/${NOTE}`)).toEqual({ view: "Notes", noteTab: "open", id: NOTE });
    expect(parseRoute(`/notes/deleted/${NOTE}`)).toEqual({ view: "Notes", noteTab: "deleted", id: NOTE });
    expect(parseRoute("/notes/deleted")).toEqual({ view: "Notes", noteTab: "deleted" });
    expect(parseRoute("/notes")).toEqual({ view: "Notes", noteTab: "open" });
    expect(parseRoute(`/tasks/${NOTE}`)).toEqual({ view: "Tasks", id: NOTE });
    expect(parseRoute(`/inbox/${NOTE}`)).toEqual({ view: "Inbox", id: NOTE });
  });

  it("puts the day and the meeting in a calendar path", () => {
    expect(parseRoute(`/calendar/2026-10-09/${MEETING}`)).toEqual({ view: "Calendar", date: "2026-10-09", id: MEETING });
    expect(parseRoute("/calendar/2026-10-09")).toEqual({ view: "Calendar", date: "2026-10-09" });
    expect(routePath({ view: "Calendar", date: "2026-10-09", id: MEETING })).toBe(`/calendar/2026-10-09/${MEETING}`);
  });

  it("round-trips every shape it builds", () => {
    for (const path of ["/today", "/notes", "/notes/deleted", `/notes/${NOTE}`, `/notes/deleted/${NOTE}`, "/calendar", "/calendar/2026-01-31", `/calendar/2026-01-31/${MEETING}`, `/people/${NOTE}`, "/knowledge", "/system"]) {
      expect(routePath(parseRoute(path)!)).toBe(path);
    }
  });

  it("ignores a trailing slash and case in the tab name", () => {
    expect(parseRoute("/Notes/")).toEqual({ view: "Notes", noteTab: "open" });
  });

  it("drops an id on tabs that have no open item, and a calendar day that is not a date", () => {
    expect(parseRoute(`/settings/${NOTE}`)).toEqual({ view: "Settings" });
    expect(parseRoute("/calendar/yesterday/x")).toEqual({ view: "Calendar" });
  });

  it("has no route for the root or an unknown tab", () => {
    expect(parseRoute("/")).toBeUndefined();
    expect(parseRoute("/nowhere")).toBeUndefined();
  });

  it("treats a malformed path as no route rather than crashing", () => {
    expect(parseRoute("/notes/%E0%A4%A")).toBeUndefined();
  });
});

describe("routeTarget: a bookmarked id that is gone (PB-027)", () => {
  const TASK = "16fd2706-8baf-433b-82eb-8c7fada847da";
  const REVIEW = "886313e1-3b8a-4372-9b90-0c9aee199e5d";
  const object = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ frontmatter: { id, type, title: type, ...extra } });
  const data = {
    notes: [object(NOTE, "knowledge-note")],
    deletedNotes: [object("deleted-note", "meeting-note", { deleted_at: "2026-10-01T00:00:00.000Z" })],
    objects: [object(NOTE, "knowledge-note"), object(MEETING, "meeting"), object(TASK, "task"), object("gone-task", "task", { deleted_at: "2026-10-01T00:00:00.000Z" })],
    pendingReviewIds: [REVIEW]
  };

  it("opens what exists", () => {
    expect(routeTarget({ view: "Notes", noteTab: "open", id: NOTE }, data)).toEqual({ kind: "ok" });
    expect(routeTarget({ view: "Calendar", date: "2026-10-09", id: MEETING }, data)).toEqual({ kind: "ok" });
    expect(routeTarget({ view: "Tasks", id: TASK }, data)).toEqual({ kind: "ok" });
    expect(routeTarget({ view: "Inbox", id: REVIEW }, data)).toEqual({ kind: "ok" });
    expect(routeTarget({ view: "Tasks" }, data)).toEqual({ kind: "ok" });
  });

  it("moves a note to the list it is now in", () => {
    expect(routeTarget({ view: "Notes", noteTab: "open", id: "deleted-note" }, data)).toEqual({ kind: "redirect", route: { view: "Notes", noteTab: "deleted", id: "deleted-note" } });
    expect(routeTarget({ view: "Notes", noteTab: "deleted", id: NOTE }, data)).toEqual({ kind: "redirect", route: { view: "Notes", noteTab: "open", id: NOTE } });
  });

  it("explains an unknown, deleted or wrong-tab id instead of opening it", () => {
    expect(routeTarget({ view: "Notes", noteTab: "open", id: "nope" }, data)).toEqual({ kind: "missing", message: "That note no longer exists." });
    expect(routeTarget({ view: "Calendar", date: "2026-10-09", id: TASK }, data)).toEqual({ kind: "missing", message: "That meeting no longer exists." });
    expect(routeTarget({ view: "Tasks", id: "gone-task" }, data)).toEqual({ kind: "missing", message: "That task no longer exists." });
    expect(routeTarget({ view: "Projects", id: TASK }, data)).toEqual({ kind: "missing", message: "That project no longer exists." });
    expect(routeTarget({ view: "Inbox", id: "accepted" }, data)).toEqual({ kind: "missing", message: "That proposal is no longer waiting in the Inbox." });
  });
});
