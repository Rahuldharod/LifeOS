import { describe, expect, it, vi } from "vitest";
import { acceptLink, acceptToast, createLinkTarget, linkResolutionView } from "./linkResolution.js";
import { labelMap, type PersonLabel } from "./personLabels.js";

// #57: link-resolution Review Items get their own card: a candidate picker, then accept with `linkTo`.

const review = (proposed: Record<string, unknown>) => ({ frontmatter: { id: "r1", title: "Link waiting for \"Joel\" on Send the deck", review_type: "link-resolution", status: "pending", proposed_fields: proposed } });
const ambiguous = { reference_field: "waiting_for", reference: "Joel", link_field: "waiting_for_person_id", list: false, candidate_type: "person", problem: "ambiguous", candidates: [{ id: "p1", title: "Joel Martin" }, { id: "p2", title: "Joël Durand" }] };
const labels = labelMap([
  { id: "p1", name: "Joel Martin", label: "Joel Martin", isExternal: false, externalSource: "email" },
  { id: "p2", name: "Joël D.", label: "Joël D. - ext", suffix: " - ext", isExternal: true, externalSource: "email" }
] satisfies PersonLabel[]);

describe("linkResolutionView", () => {
  it("GIVEN several candidates THEN lists each by display label with the external marker, and names the unresolved text", () => {
    const view = linkResolutionView(review(ambiguous), labels);
    expect(view).toMatchObject({ reference: "Joel", fieldLabel: "waiting for", candidateType: "person", problem: "ambiguous" });
    expect(view.options).toEqual([{ id: "p1", name: "Joel Martin" }, { id: "p2", name: "Joël D.", suffix: " - ext" }]);
    expect(view.explanation).toBe("\"Joel\" matches 2 people. Choose the one you meant.");
  });

  it("falls back to the stored title for a candidate the labels do not know, and uses titles for non-person types", () => {
    expect(linkResolutionView(review(ambiguous), labelMap([])).options).toEqual([{ id: "p1", name: "Joel Martin" }, { id: "p2", name: "Joël Durand" }]);
    const project = linkResolutionView(review({ ...ambiguous, reference_field: "project", candidate_type: "project", candidates: [{ id: "x", title: "Atlas" }] }), labels);
    expect(project.options).toEqual([{ id: "x", name: "Atlas" }]);
  });

  it("GIVEN no candidates THEN explains there is no match and offers to create one when the type can be created", () => {
    const view = linkResolutionView(review({ ...ambiguous, problem: "unknown", candidates: [] }), labels);
    expect(view.options).toEqual([]);
    expect(view.explanation).toBe("No person matches \"Joel\".");
    expect(view.canCreate).toBe(true);
    const meeting = linkResolutionView(review({ ...ambiguous, reference_field: "meeting", candidate_type: "meeting", problem: "unknown", candidates: [] }), labels);
    expect(meeting.canCreate).toBe(false);
  });

  it("tolerates a malformed proposal without throwing", () => {
    const view = linkResolutionView(review({}), labels);
    expect(view.options).toEqual([]);
    expect(view.canCreate).toBe(false);
  });
});

describe("acceptToast", () => {
  it("matches the item type", () => {
    expect(acceptToast({ review_type: "create", target_object_type: "task" })).toBe("Task accepted and published");
    expect(acceptToast({ review_type: "create", target_object_type: "open-point" })).toBe("Open point accepted and published");
    expect(acceptToast({ review_type: "link-resolution" })).toBe("Link saved");
    expect(acceptToast({ review_type: "person-merge" })).toBe("People merged");
    expect(acceptToast({ review_type: "update" })).toBe("Change applied");
    expect(acceptToast({ review_type: "summary" })).toBe("Summary added to the meeting");
  });
});

describe("requests", () => {
  it("accept sends the chosen candidate as linkTo", async () => {
    const call = vi.fn().mockResolvedValue({});
    await acceptLink(call, "r1", "p2");
    expect(call).toHaveBeenCalledWith("/api/v1/review-items/r1/accept", { method: "POST", body: JSON.stringify({ linkTo: "p2" }) });
  });

  it("create posts the unresolved text as the new object's title and returns its ID and title", async () => {
    const call = vi.fn().mockResolvedValue({ frontmatter: { id: "new", title: "Joel" } });
    await expect(createLinkTarget(call, "person", "Joel")).resolves.toEqual({ id: "new", name: "Joel" });
    expect(call).toHaveBeenCalledWith("/api/v1/entities/person", { method: "POST", body: JSON.stringify({ fields: { title: "Joel" } }) });
  });
});
