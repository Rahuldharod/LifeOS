import { describe, expect, it } from "vitest";
import { buildTrail, type TrailData } from "./trail.js";

const obj = (id: string, type: string, title: string, extra: Record<string, unknown> = {}) => ({ frontmatter: { id, type, title, ...extra } });
const data: TrailData = {
  notes: [obj("00000000-0000-4000-8000-000000000001", "knowledge-note", "Pricing notes"), obj("00000000-0000-4000-8000-000000000002", "knowledge-note", "   ")],
  deletedNotes: [obj("00000000-0000-4000-8000-000000000003", "knowledge-note", "Old idea", { deleted_at: "2026-10-01T00:00:00Z" })],
  objects: [
    obj("00000000-0000-4000-8000-000000000004", "task", "Send the deck"), obj("00000000-0000-4000-8000-000000000005", "decision", "Use Postgres"), obj("00000000-0000-4000-8000-000000000006", "open-point", "Who owns rollout?"),
    obj("00000000-0000-4000-8000-000000000007", "project", "Launch"), obj("00000000-0000-4000-8000-000000000008", "client", "Acme"), obj("00000000-0000-4000-8000-000000000009", "product", "Widget"), obj("00000000-0000-4000-8000-000000000010", "person", "Sam Example"),
    obj("00000000-0000-4000-8000-000000000011", "meeting", "Weekly sync"), obj("00000000-0000-4000-8000-000000000012", "review-item", "Proposed task: call Sam")
  ],
  pendingReviewIds: ["00000000-0000-4000-8000-000000000012"]
};
const labels = (route: Parameters<typeof buildTrail>[0], options: Parameters<typeof buildTrail>[2] = {}) => buildTrail(route, data, options).map((crumb) => crumb.label);

describe("buildTrail (PB-026)", () => {
  it("builds Notes > title, the tab crumb keeping the open list", () => {
    expect(buildTrail({ view: "Notes", noteTab: "open", id: "00000000-0000-4000-8000-000000000001" }, data)).toEqual([{ label: "Notes", route: { view: "Notes", noteTab: "open" } }, { label: "Pricing notes" }]);
  });

  it("builds Notes > Deleted > title with links back to the deleted list", () => {
    expect(buildTrail({ view: "Notes", noteTab: "deleted", id: "00000000-0000-4000-8000-000000000003" }, data)).toEqual([
      { label: "Notes", route: { view: "Notes", noteTab: "deleted" } },
      { label: "Deleted", route: { view: "Notes", noteTab: "deleted" } },
      { label: "Old idea" }
    ]);
  });

  it("builds Calendar > day > title; the day crumb has no meeting", () => {
    expect(buildTrail({ view: "Calendar", date: "2026-10-03", id: "00000000-0000-4000-8000-000000000011" }, data)).toEqual([
      { label: "Calendar", route: { view: "Calendar" } },
      { label: "3 Oct", route: { view: "Calendar", date: "2026-10-03" } },
      { label: "Weekly sync" }
    ]);
  });

  it.each([
    ["Tasks", "00000000-0000-4000-8000-000000000004", "Send the deck"], ["Decisions", "00000000-0000-4000-8000-000000000005", "Use Postgres"], ["Open Points", "00000000-0000-4000-8000-000000000006", "Who owns rollout?"],
    ["Projects", "00000000-0000-4000-8000-000000000007", "Launch"], ["Clients", "00000000-0000-4000-8000-000000000008", "Acme"], ["Products", "00000000-0000-4000-8000-000000000009", "Widget"], ["People", "00000000-0000-4000-8000-000000000010", "Sam Example"]
  ] as const)("builds %s > title", (view, id, title) => {
    expect(buildTrail({ view, id }, data)).toEqual([{ label: view, route: { view } }, { label: title }]);
  });

  it("builds Inbox > proposal title", () => {
    expect(buildTrail({ view: "Inbox", id: "00000000-0000-4000-8000-000000000012" }, data)).toEqual([{ label: "Inbox", route: { view: "Inbox" } }, { label: "Proposed task: call Sam" }]);
  });

  it("falls back to the review list for an Inbox title", () => {
    const only = { ...data, objects: [], reviews: [obj("00000000-0000-4000-8000-000000000012", "review-item", "From review list")] };
    expect(buildTrail({ view: "Inbox", id: "00000000-0000-4000-8000-000000000012" }, only).at(-1)?.label).toBe("From review list");
  });

  it("calls a blank saved title Untitled", () => {
    expect(labels({ view: "Notes", noteTab: "open", id: "00000000-0000-4000-8000-000000000002" })).toEqual(["Notes", "Untitled"]);
  });

  it("shows New meeting for an unsaved meeting on a day", () => {
    expect(labels({ view: "Calendar", date: "2026-10-03" }, { unsavedMeeting: true })).toEqual(["Calendar", "3 Oct", "New meeting"]);
  });

  it("has no trail on routes without an item", () => {
    for (const route of [{ view: "Today" }, { view: "Knowledge" }, { view: "System" }, { view: "Settings" }, { view: "Tasks" }, { view: "Inbox" }, { view: "Calendar", date: "2026-10-03" }, { view: "Notes", noteTab: "open" }] as const) {
      expect(buildTrail(route, data)).toEqual([]);
    }
  });

  it("has no trail when the item is missing or sits in the other notes list", () => {
    expect(buildTrail({ view: "Tasks", id: "nope" }, data)).toEqual([]);
    expect(buildTrail({ view: "Notes", noteTab: "open", id: "00000000-0000-4000-8000-000000000003" }, data)).toEqual([]);
    expect(buildTrail({ view: "Inbox", id: "gone" }, data)).toEqual([]);
  });
});
