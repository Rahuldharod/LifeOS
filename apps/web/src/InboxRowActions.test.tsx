// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject, ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace } from "./InboxWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review = (id: string, title: string, fields: Record<string, unknown> = {}): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}\n\nProposed from the source.`, evidence: {},
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_meeting_id: "meeting-1", source_ids: [], proposed_fields: { title }, ...fields }
});
const meeting: LifeObject = { relativePath: "meetings/meeting-1.md", contentHash: "m", body: "# Pilot review", frontmatter: { id: "meeting-1", type: "meeting", schema_version: 1, revision: 1, title: "Pilot review", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z" } };
const choices = { people: [], projects: [], clients: [], products: [] };
const now = new Date("2026-10-10T12:00:00Z");

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** #239: row and group buttons. A stateful Inbox: decided items leave `reviews`. */
const queue = () => [
  review("a", "Alpha task", { created_at: "2026-10-10T10:00:00Z" }),
  review("b", "Bravo task", { created_at: "2026-10-10T09:00:00Z" }),
  review("l", "Link owner", { created_at: "2026-10-10T08:00:00Z", review_type: "link-resolution" }),
  review("c", "Charlie decision", { created_at: "2026-10-10T07:00:00Z", target_object_type: "decision" }),
  review("d", "Delta task", { created_at: "2026-10-10T06:00:00Z" })
];
const decided: string[] = [];
const linkRejected: string[] = [];

function Harness({ selectedId, initial = queue() }: { selectedId: string; initial?: ReviewItem[] }) {
  const [reviews, setReviews] = React.useState(initial);
  const [route, setRoute] = React.useState<string | undefined>(selectedId);
  const remove = (id: string) => setReviews((current) => current.filter((entry) => entry.frontmatter.id !== id));
  const decide = (outcome: string) => async (item: { frontmatter: { id: string } }) => { decided.push(`${outcome}:${item.frontmatter.id}`); remove(item.frontmatter.id); return true; };
  return <InboxWorkspace reviews={reviews} selectedId={route} objects={[meeting]} labels={new Map()} choices={choices} readOnly={false} busy={false} displayTimeZone="Europe/Paris" now={now}
    onOpen={(id) => setRoute(id)} onAccept={decide("accepted")} onReject={decide("rejected")} onSave={async () => true}
    linkActionsFor={(id) => ({ onCreate: async () => ({}) as never, onLink: async () => undefined, onReject: async () => { linkRejected.push(id); remove(id); } })} />;
}

async function mount(selectedId = "a", initial?: ReviewItem[]) {
  decided.length = 0; linkRejected.length = 0;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness selectedId={selectedId} {...(initial ? { initial } : {})} />));
}

const row = (title: string) => [...document.querySelectorAll<HTMLElement>(".inbox-row:not(.inbox-colhead)")].find((item) => item.querySelector("strong")?.textContent === title);
const focusedTitle = () => document.querySelector(".inbox-row.focused .inbox-row-open strong")?.textContent;
const detailTitle = () => document.querySelector("[aria-label='Review detail'] h2")?.textContent;
const status = () => document.querySelector("[role='status']")?.textContent;
const isTicked = (title: string) => (document.querySelector(`[aria-label='Select proposal: ${title}']`) as HTMLInputElement).checked;
const rowButton = (title: string, verb: string) => document.querySelector<HTMLButtonElement>(`[aria-label='${verb}: ${title}']`)!;
const click = async (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
const groupButton = (name: RegExp) => [...document.querySelectorAll<HTMLButtonElement>(".inbox-group-actions button")].find((button) => name.test(button.getAttribute("aria-label") ?? ""))!;

describe("row buttons", () => {
  it("sit in their own last cell with accessible names; Accept and Reject act on that row, then focus moves on", async () => {
    await mount("a");
    const cells = [...row("Bravo task")!.children];
    const actions = cells[cells.length - 1]!;
    expect(actions.classList.contains("c-actions")).toBe(true);
    expect(actions.contains(row("Bravo task")!.querySelector(".inbox-row-open"))).toBe(false);
    await click(rowButton("Bravo task", "Accept proposal"));
    expect(decided).toEqual(["accepted:b"]);
    expect(detailTitle()).toBe("Alpha task"); // another item stays open
    expect(focusedTitle()).toBe("Link owner");
    await click(rowButton("Delta task", "Reject proposal"));
    expect(decided).toEqual(["accepted:b", "rejected:d"]);
    expect(focusedTitle()).toBe("Charlie decision"); // last item: focus lands on the one above
  });

  it("do not open or tick the row; the Open button opens it without ticking", async () => {
    await mount("a");
    await click(rowButton("Bravo task", "Open in reading pane"));
    expect(detailTitle()).toBe("Bravo task");
    expect(focusedTitle()).toBe("Bravo task");
    await click(row("Delta task")!.querySelector(".c-actions")!); // a stray click on the cell is swallowed
    expect(detailTitle()).toBe("Bravo task");
    expect(isTicked("Delta task")).toBe(false);
    await click(rowButton("Charlie decision", "Reject proposal"));
    expect(detailTitle()).toBe("Bravo task"); // acting on a row does not open it
    expect(isTicked("Delta task")).toBe(false);
  });

  it("have no Accept for Link items; Reject still works through the link actions", async () => {
    await mount("a");
    expect(rowButton("Link owner", "Accept proposal").disabled).toBe(true);
    await click(rowButton("Link owner", "Reject proposal"));
    expect(linkRejected).toEqual(["l"]);
    expect(decided).toEqual([]);
  });

  it("on the Open item, unsaved edits block Accept and are kept", async () => {
    await mount("a");
    const title = document.querySelector("[aria-label='Proposed title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Alpha task, revised"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(rowButton("Alpha task", "Accept proposal"));
    expect(decided).toEqual([]);
    expect(status()).toBe("Save your edits first, then accept.");
    expect((document.querySelector("[aria-label='Proposed title']") as HTMLInputElement).value).toBe("Alpha task, revised");
  });

  it("are disabled when read-only, but Open stays available", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<InboxWorkspace reviews={queue()} selectedId="a" objects={[meeting]} labels={new Map()} choices={choices} readOnly busy={false} displayTimeZone="Europe/Paris" now={now} onAccept={async () => true} onReject={async () => true} onSave={async () => true} />));
    expect(rowButton("Bravo task", "Accept proposal").disabled).toBe(true);
    expect(rowButton("Bravo task", "Reject proposal").disabled).toBe(true);
    expect(groupButton(/^Accept all/).disabled).toBe(true);
    expect(groupButton(/^Reject all/).disabled).toBe(true);
    expect(rowButton("Bravo task", "Open in reading pane").disabled).toBe(false);
  });
});

describe("group buttons", () => {
  it("Accept all acts on that group only, skips Link, reports the skip and moves focus on", async () => {
    await mount("a", [review("a", "Alpha", { created_at: "2026-10-10T10:00:00Z" }), review("l", "Link owner", { created_at: "2026-10-10T09:00:00Z", review_type: "link-resolution" }), review("o", "Other one", { created_at: "2026-10-10T08:00:00Z", source_meeting_id: undefined })]);
    await click(groupButton(/Accept all in Meeting · Pilot review/));
    expect(decided).toEqual(["accepted:a"]); // "Other one" is in another group and stays
    expect(status()).toBe("1 proposal accepted · 1 skipped (link or merge needs a choice)");
    expect(focusedTitle()).toBe("Link owner");
  });

  it("Reject all asks first, then rejects every item of the group", async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    await mount("a");
    await click(groupButton(/Reject all/));
    expect(confirm).toHaveBeenCalledWith("Reject 5 proposals? This cannot be undone.");
    expect(decided).toEqual([]);
    confirm.mockReturnValue(true);
    await click(groupButton(/Reject all/));
    expect(decided.sort()).toEqual(["rejected:a", "rejected:b", "rejected:c", "rejected:d", "rejected:l"]);
  });

  it("Accept all with only Link items says how many were skipped", async () => {
    await mount("l", [review("l", "Link owner", { review_type: "link-resolution" })]);
    await click(groupButton(/^Accept all/));
    expect(decided).toEqual([]);
    expect(status()).toBe("1 skipped (link or merge needs a choice)");
  });

  it("the toggle still collapses; its buttons do not collapse or open anything", async () => {
    await mount("a");
    await click(groupButton(/^Accept all/));
    expect(decided).toEqual(["accepted:a", "accepted:b", "accepted:c", "accepted:d"]);
    expect(document.querySelector(".inbox-source")?.getAttribute("aria-expanded")).toBe("true");
    await click(document.querySelector(".inbox-source")!);
    expect(row("Link owner")).toBeUndefined();
  });
});
