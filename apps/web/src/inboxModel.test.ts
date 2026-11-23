import { describe, expect, it } from "vitest";
import type { InboxReview } from "./inboxModel.js";
import { adjacentId, dateBucket, groupKey, groupReviews, processedToday, rangeIds, reviewKind, reviewRowCells } from "./inboxModel.js";

const review = (id: string, createdAt: string, front: Record<string, unknown> = {}): InboxReview => ({
  relativePath: `review-items/${id}.md`, contentHash: id, body: `# ${id}`,
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title: `Title ${id}`, created_at: createdAt, updated_at: createdAt, updated_by_device: "t", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", proposed_fields: {}, ...front }
}) as InboxReview;

const zone = "Europe/Paris";
const now = new Date("2026-11-23T10:00:00Z");

describe("reviewKind", () => {
  it.each([
    [{ review_type: "create", target_object_type: "task" }, "Task"],
    [{ review_type: "create", target_object_type: "decision" }, "Decision"],
    [{ review_type: "create", target_object_type: "open-point" }, "Open point"],
    [{ review_type: "create", target_object_type: "knowledge-note" }, "Knowledge note"],
    [{ review_type: "update", target_object_type: "task" }, "Change"],
    [{ review_type: "summary", target_object_type: "meeting" }, "Summary"],
    [{ review_type: "link-resolution", target_object_type: "source" }, "Link"],
    [{ review_type: "person-merge", target_object_type: "person" }, "Merge"],
    [{ target_object_type: "decision" }, "Decision"]
  ])("maps %j to %s", (front, kind) => expect(reviewKind(review("r", "2026-11-23T08:00:00Z", front))).toBe(kind));
});

describe("dateBucket", () => {
  it("uses the display timezone for the day boundary", () => {
    expect(dateBucket("2026-11-22T23:30:00Z", now, zone)).toBe("Today"); // 00:30 on the 23rd in Paris
    expect(dateBucket("2026-11-22T22:30:00Z", now, zone)).toBe("Yesterday"); // 23:30 on the 22nd in Paris
  });
  it("buckets by calendar days ago", () => {
    expect(dateBucket("2026-11-23T08:00:00Z", now, zone)).toBe("Today");
    expect(dateBucket("2026-11-22T12:00:00Z", now, zone)).toBe("Yesterday");
    expect(dateBucket("2026-11-21T12:00:00Z", now, zone)).toBe("Earlier this week");
    expect(dateBucket("2026-11-17T12:00:00Z", now, zone)).toBe("Earlier this week");
    expect(dateBucket("2026-11-16T12:00:00Z", now, zone)).toBe("Older");
    expect(dateBucket("not a date", now, zone)).toBe("Older");
  });
});

describe("groupReviews", () => {
  const titles = new Map([["m1", "Acme sync"], ["m2", "POS review"]]);
  const group = (reviews: InboxReview[]) => groupReviews(reviews, { now, timeZone: zone, meetingTitle: (id) => titles.get(id) });

  it("groups by date, then Source meeting, then Agent run, then Other", () => {
    const groups = group([
      review("a", "2026-11-23T09:00:00Z", { source_meeting_id: "m1" }),
      review("b", "2026-11-23T08:00:00Z", { agent_run_id: "run-7" }),
      review("c", "2026-11-23T07:00:00Z"),
      review("d", "2026-11-22T09:00:00Z", { source_meeting_id: "m2" })
    ]);
    expect(groups.map((entry) => entry.bucket)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]!.sources.map((source) => source.label)).toEqual(["Meeting · Acme sync", "Agent run · run-7", "Other"]);
    expect(groups[1]!.sources[0]!.label).toBe("Meeting · POS review");
  });

  it("orders groups by their newest item and items newest first", () => {
    const groups = group([
      review("old-1", "2026-11-23T06:00:00Z", { source_meeting_id: "m1" }),
      review("new-2", "2026-11-23T09:30:00Z", { source_meeting_id: "m2" }),
      review("old-3", "2026-11-23T08:00:00Z", { source_meeting_id: "m1" })
    ]);
    const [first, second] = groups[0]!.sources;
    expect(first!.label).toBe("Meeting · POS review");
    expect(second!.items.map((item) => item.frontmatter.id)).toEqual(["old-3", "old-1"]);
  });

  it("keeps a meeting whose title is unknown as its own group and uses stable keys", () => {
    const groups = group([review("a", "2026-11-23T09:00:00Z", { source_meeting_id: "gone" })]);
    expect(groups[0]!.sources[0]!.label).toBe("Meeting · unavailable");
    expect(groupKey("Today", groups[0]!.sources[0]!)).toBe("Today|meeting:gone");
  });

  it("puts date buckets in Today, Yesterday, Earlier this week, Older order whatever the input order", () => {
    const groups = group([review("o", "2026-10-01T09:00:00Z"), review("t", "2026-11-23T09:00:00Z"), review("e", "2026-11-19T09:00:00Z"), review("y", "2026-11-22T12:00:00Z")]);
    expect(groups.map((entry) => entry.bucket)).toEqual(["Today", "Yesterday", "Earlier this week", "Older"]);
  });
});

describe("rangeIds", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("runs from the anchor to the item, in either direction, inclusive", () => {
    expect(rangeIds(ids, new Set(), "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeIds(ids, new Set(), "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("skips hidden (collapsed) ids", () => {
    expect(rangeIds(ids, new Set(["c"]), "a", "d")).toEqual(["a", "b", "d"]);
  });
  it("is just the item without a usable anchor", () => {
    expect(rangeIds(ids, new Set(), undefined, "c")).toEqual(["c"]);
    expect(rangeIds(ids, new Set(), "zzz", "c")).toEqual(["c"]);
    expect(rangeIds(ids, new Set(["a"]), "a", "c")).toEqual(["c"]);
  });
});

describe("adjacentId", () => {
  const ids = ["a", "b", "c", "d"];
  it("steps over hidden (collapsed) ids", () => {
    expect(adjacentId(ids, new Set(["b", "c"]), "a", 1)).toBe("d");
    expect(adjacentId(ids, new Set(["b"]), "c", -1)).toBe("a");
    expect(adjacentId(ids, new Set(), "d", 1)).toBeUndefined();
  });
  it("works from an item that is itself hidden", () => {
    expect(adjacentId(ids, new Set(["b", "c"]), "b", 1)).toBe("d");
  });
  it("falls back to the first shown id when the start is unknown", () => {
    expect(adjacentId(ids, new Set(["a"]), "zzz", 1)).toBe("b");
  });
});

describe("reviewRowCells", () => {
  const lookups = { now, timeZone: zone, personName: (id: string) => id === "p1" ? "Paula Martin" : undefined, projectName: (id: string) => id === "pr1" ? "Store rollout" : undefined };

  it("reads owner, due, project and time for a task", () => {
    const cells = reviewRowCells(review("t", "2026-11-23T08:15:00Z", { primary_project_id: "pr1", proposed_fields: { owner_person_id: "p1", due_on: "2026-11-28" } }), lookups);
    expect(cells).toMatchObject({ owner: "Paula Martin", due: "28 Nov", project: "Store rollout", time: "09:15", low: false });
  });
  it("shows Me for a task with no owner, nothing for kinds without an owner, and the date for older items", () => {
    expect(reviewRowCells(review("t", "2026-11-20T08:00:00Z"), lookups)).toMatchObject({ owner: "Me", due: undefined, project: undefined, time: "20 Nov" });
    expect(reviewRowCells(review("d", "2026-11-23T08:00:00Z", { target_object_type: "decision" }), lookups).owner).toBeUndefined();
  });
  it("flags low confidence only", () => {
    expect(reviewRowCells(review("l", "2026-11-23T08:00:00Z", { confidence_label: "Low" }), lookups).low).toBe(true);
    expect(reviewRowCells(review("m", "2026-11-23T08:00:00Z", { confidence_label: "Medium" }), lookups).low).toBe(false);
  });
});

describe("processedToday", () => {
  const zone = "Europe/Paris";
  const now = new Date("2026-11-23T12:00:00Z");
  const entry = (at: string, over: { actor?: string; undone?: boolean } = {}) => ({ at, actor: "you", undone: false, ...over });

  it("counts the user's actions that fell on today in the display time zone, at both midnight edges", () => {
    expect(processedToday([
      entry("2026-11-22T22:59:59Z"), // 23:59:59 on the 22nd in Paris: yesterday
      entry("2026-11-22T23:00:00Z"), // 00:00 on the 23rd: today
      entry("2026-11-23T12:00:00Z"),
      entry("2026-11-23T22:59:59Z"), // 23:59:59 on the 23rd: still today
      entry("2026-11-23T23:00:00Z") // 00:00 on the 24th: tomorrow
    ], now, zone)).toBe(3);
  });

  it("leaves out undone actions and System actions", () => {
    expect(processedToday([entry("2026-11-23T09:00:00Z"), entry("2026-11-23T09:01:00Z", { undone: true }), entry("2026-11-23T09:02:00Z", { actor: "system" })], now, zone)).toBe(1);
  });

  it("is 0 for no entries", () => { expect(processedToday([], now, zone)).toBe(0); });
});
