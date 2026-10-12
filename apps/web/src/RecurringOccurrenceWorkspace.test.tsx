// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, LifeObject, OccurrenceWorkspaceItem } from "@lifeos/contracts";
import { defaultOccurrenceSection, occurrenceNotes, RecurringOccurrenceWorkspace, replaceOccurrenceNotes } from "./RecurringOccurrenceWorkspace.js";
import { CalendarWorkspace } from "./CalendarWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const object = (id: string, type: string, title: string, fields: Record<string, unknown> = {}, body = ""): LifeObject => ({ relativePath: `${type}s/${id}.md`, contentHash: `${id}-hash`, body, frontmatter: { id, type, title, revision: 1, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", ...fields } });
const occurrence = (sectionId: string, startsAt: string, fields: Record<string, unknown> = {}): OccurrenceWorkspaceItem => ({ sectionId, occurrenceId: `series:${startsAt}`, originalStartsAt: startsAt, meeting: object(`meeting-${sectionId}`, "meeting", "Weekly review", { starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), location: "Room Atlas", join_url: "https://meet.example.test/weekly", ...fields }, fields.meetingBody as string ?? ""), reviews: fields.reviews as LifeObject[] ?? [], sources: fields.sources as LifeObject[] ?? [], context: { people: [object(`person-${sectionId}`, "person", "Alex Example")] } });
const older = occurrence("occurrence-old", "2026-10-05T08:00:00.000Z");
const newer = occurrence("occurrence-new", "2026-10-12T08:00:00.000Z", { attendee_snapshot: ["Alex Example"], meetingBody: "<!-- lifeos:summary:start -->\n## Summary\nAccepted outcome\n<!-- lifeos:summary:end -->", sources: [object("source", "source", "Transcript", { url: "https://example.test/transcript" })], reviews: [object("review", "review-item", "Create task", { status: "pending" })] });
const markdown = `## Weekly — newer\n<a id="occurrence-new"></a>\n\nNewer notes\n\n## Weekly — older\n<a id="occurrence-old"></a>\n\nOlder notes`;
const note = object("note", "meeting-note", "Weekly notes", { occurrence_sections: [] }, markdown);
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("RecurringOccurrenceWorkspace", () => {
  it("selects today, otherwise the next future occurrence, otherwise the latest past", () => {
    expect(defaultOccurrenceSection([newer, older], new Date("2026-10-12T12:00:00Z"), "Europe/Paris")).toBe("occurrence-new");
    expect(defaultOccurrenceSection([newer, older], new Date("2026-10-06T12:00:00Z"), "Europe/Paris")).toBe("occurrence-new");
    expect(defaultOccurrenceSection([newer, older], new Date("2026-10-20T12:00:00Z"), "Europe/Paris")).toBe("occurrence-new");
  });

  it("edits one historical section without rewriting its neighbour", () => {
    expect(occurrenceNotes(markdown, [newer, older], older.sectionId)).toBe("Older notes");
    const changed = replaceOccurrenceNotes(markdown, [newer, older], older.sectionId, "Edited history");
    expect(changed).toContain("Newer notes");
    expect(changed).toContain("Edited history");
    expect(changed).not.toContain("Older notes");
  });

  it("keeps a trailing space or line break while the user is typing in a section", () => {
    for (const typed of ["Edited ", "Edited\n", "Edited history "]) {
      for (const sectionId of [newer.sectionId, older.sectionId]) {
        const changed = replaceOccurrenceNotes(markdown, [newer, older], sectionId, typed);
        expect(occurrenceNotes(changed, [newer, older], sectionId)).toBe(typed);
        expect(occurrenceNotes(changed, [newer, older], sectionId === newer.sectionId ? older.sectionId : newer.sectionId)).toBe(sectionId === newer.sectionId ? "Older notes" : "Newer notes");
      }
    }
  });

  it("shows shared history while only the unsaved occurrence is editable", async () => {
    const pending = occurrence("occurrence-pending", "2026-10-19T08:00:00.000Z");
    const changePending = vi.fn();
    const changeStored = vi.fn();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace
      note={note}
      occurrences={[older, newer]}
      pendingOccurrence={pending}
      pendingNotes=""
      timeZone="Europe/Paris"
      mode="calendar"
      readOnly={false}
      onBodyChange={changeStored}
      onPendingNotesChange={changePending}
      renderProposal={() => null}
    />));

    const pendingArea = document.querySelector("textarea[aria-label='Notes for occurrence-pending']") as HTMLTextAreaElement;
    const olderArea = document.querySelector("textarea[aria-label='Notes for occurrence-old']") as HTMLTextAreaElement;
    expect(document.body.textContent).toContain("Older notes");
    expect(document.body.textContent).toContain("Not saved yet");
    expect(pendingArea.disabled).toBe(false);
    expect(olderArea.disabled).toBe(true);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(pendingArea, "This week's notes"); pendingArea.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(changePending).toHaveBeenCalledWith("This week's notes");
    expect(changeStored).not.toHaveBeenCalled();
  });

  it("keeps the app-managed Materials block out of editable notes and preserves it on edit (#151)", () => {
    const withMaterials = markdown.replace("Newer notes", `Newer notes\n\n<!-- lifeos:materials:start occurrence-new -->\n\n### Materials\n\n- [Transcript](https://example.test/transcript)\n\n<!-- lifeos:materials:end occurrence-new -->`);
    expect(occurrenceNotes(withMaterials, [newer, older], newer.sectionId)).toBe("Newer notes");
    const changed = replaceOccurrenceNotes(withMaterials, [newer, older], newer.sectionId, "Revised notes");
    expect(changed).toContain("Revised notes");
    expect(changed).toContain("[Transcript](https://example.test/transcript)");
    expect(changed.match(/lifeos:materials:start/g)).toHaveLength(1);
  });

  it("focuses the requested section and shows snapshots, current changes, materials, summary and selected Calendar proposals", async () => {
    const onBodyChange = vi.fn();
    const current: CalendarEvent = { externalId: "event", title: "Weekly review moved", startsAt: "2026-10-12T09:00:00.000Z", endsAt: "2026-10-12T10:00:00.000Z", timezone: "Europe/Paris", originalOccurrenceStartsAt: newer.originalStartsAt, attendees: ["Alex Example", "Jamie Example"], location: "Room Beacon" };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={note} occurrences={[older, newer]} selectedSectionId="occurrence-new" timeZone="Europe/Paris" mode="calendar" currentEvent={current} readOnly={false} onBodyChange={onBodyChange} renderProposal={(review) => <button>{review.frontmatter.title}</button>} />));
    expect(document.querySelector("details.selected")?.getAttribute("open")).not.toBeNull();
    expect(document.body.textContent).toMatch(/Saved event details.*Room Atlas.*Changed in Calendar.*Room Beacon.*Jamie Example.*Materials.*Transcript.*Accepted summary.*Accepted outcome.*Pending proposals.*Create task/is);
    expect(document.body.textContent?.match(/Create task/g)).toHaveLength(1);
    const area = document.querySelector("textarea[aria-label='Notes for occurrence-old']") as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Revised older notes"); area.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(onBodyChange).toHaveBeenCalledWith(expect.stringContaining("Revised older notes"));
  });

  it("closes an open occurrence when its title is clicked again, re-opens it, and never writes (#184)", async () => {
    const onBodyChange = vi.fn();
    const onSelectSection = vi.fn();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={note} occurrences={[older, newer]} selectedSectionId="occurrence-new" timeZone="Europe/Paris" mode="calendar" readOnly={false} onBodyChange={onBodyChange} onSelectSection={onSelectSection} renderProposal={() => null} />));
    const details = document.querySelector("details.occurrence-section.selected") as HTMLDetailsElement;
    const summary = details.querySelector("summary") as HTMLElement;
    expect(details.hasAttribute("open")).toBe(true);
    await act(async () => { summary.click(); });
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("textarea")).not.toBeNull(); // still mounted: typing is kept
    await act(async () => { summary.click(); });
    expect(details.hasAttribute("open")).toBe(true);
    expect(onBodyChange).not.toHaveBeenCalled();
  });

  it("toggles an occurrence from the keyboard: Enter and Space on the summary close then open it (#184)", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={note} occurrences={[older, newer]} selectedSectionId="occurrence-new" timeZone="Europe/Paris" mode="calendar" readOnly={false} onBodyChange={() => undefined} renderProposal={() => null} />));
    const details = document.querySelector("details.occurrence-section.selected") as HTMLDetailsElement;
    const summary = details.querySelector("summary") as HTMLElement;
    // A browser turns Enter or Space on a focused <summary> into a click; happy-dom does not, so dispatch what it does:
    // the key events, then the click the browser would synthesise from them.
    const press = async (key: string) => { await act(async () => { summary.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); summary.click(); summary.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true })); }); };
    await press("Enter");
    expect(details.hasAttribute("open")).toBe(false);
    await press(" ");
    expect(details.hasAttribute("open")).toBe(true);
  });

  it("groups pending proposals under every occurrence in Notes", async () => {
    const withOlderReview = { ...older, reviews: [object("older-review", "review-item", "Older proposal", { status: "pending" })] };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={note} occurrences={[withOlderReview, newer]} timeZone="Europe/Paris" mode="notes" readOnly={false} onBodyChange={() => undefined} renderProposal={(review) => <p>{review.frontmatter.title}</p>} />));
    expect(document.body.textContent).toContain("Create task");
    expect(document.body.textContent).toContain("Older proposal");
  });

  it("offers an explicit previous-Note link without inferring continuity", async () => {
    const link = vi.fn();
    const previous = object("previous", "meeting-note", "Earlier weekly notes", { recurrence_series_id: "series-before" });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={{ ...note, frontmatter: { ...note.frontmatter, recurrence_series_id: "series-restart" } }} occurrences={[newer]} seriesNotes={[previous]} timeZone="Europe/Paris" mode="notes" readOnly={false} onBodyChange={() => undefined} onLinkPrevious={link} renderProposal={() => null} />));
    const select = document.querySelector("select[aria-label='Previous recurring Note']") as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "previous"); select.dispatchEvent(new Event("change", { bubbles: true })); });
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Link previous Note") as HTMLButtonElement;
    await act(async () => button.click());
    expect(link).toHaveBeenCalledWith("previous");
  });

  it("uses immutable attendee labels and does not report unchanged provider labels as a Calendar change", async () => {
    const snapshotted = { ...newer, meeting: object("meeting-new", "meeting", "Weekly review", { starts_at: newer.meeting.frontmatter.starts_at, ends_at: newer.meeting.frontmatter.ends_at, attendee_snapshot: ["Alex Original", "Room 4"] }), context: { people: [object("person", "person", "Alex Renamed")] } };
    const current: CalendarEvent = { externalId: "event", title: "Weekly review", startsAt: String(snapshotted.meeting.frontmatter.starts_at), endsAt: String(snapshotted.meeting.frontmatter.ends_at), timezone: "Europe/Paris", originalOccurrenceStartsAt: snapshotted.originalStartsAt, attendees: ["Alex Original", "Room 4"] };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={note} occurrences={[snapshotted]} timeZone="Europe/Paris" mode="calendar" currentEvent={current} readOnly={false} onBodyChange={() => undefined} renderProposal={() => null} />));
    expect(document.body.textContent).toContain("Alex Original, Room 4");
    expect(document.body.textContent).not.toContain("Alex Renamed");
    expect(document.body.textContent).not.toContain("Changed in Calendar");
  });

  it("labels an existing occurrence section when Calendar cancels it", async () => {
    const current: CalendarEvent = { externalId: "event", title: "Weekly review", startsAt: String(newer.meeting.frontmatter.starts_at), endsAt: String(newer.meeting.frontmatter.ends_at), timezone: "Europe/Paris", originalOccurrenceStartsAt: newer.originalStartsAt, attendees: [], status: "cancelled" };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<RecurringOccurrenceWorkspace note={note} occurrences={[newer]} timeZone="Europe/Paris" mode="calendar" currentEvent={current} readOnly={false} onBodyChange={() => undefined} renderProposal={() => null} />));
    expect(document.querySelector("summary")?.textContent).toContain("Cancelled");
  });

  it("preserves the chosen section through narrow Back and remounts it when detail reopens", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "(max-width: 760px)", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    const back = vi.fn();
    const props = { selectedDate: "2026-10-12", displayTimeZone: "Europe/Paris", events: [] as CalendarEvent[], filter: "all", offered: [], busy: false, readOnly: false, loading: false, detailOpen: true, onPreviousDay: vi.fn(), onToday: vi.fn(), onNextDay: vi.fn(), onDateChange: vi.fn(), onFilterChange: vi.fn(), onRetry: vi.fn(), onSelectEvent: vi.fn(), onBack: back };
    const occurrenceView = () => <RecurringOccurrenceWorkspace note={note} occurrences={[older, newer]} timeZone="Europe/Paris" mode="calendar" readOnly={false} onBodyChange={() => undefined} renderProposal={() => null} />;
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<CalendarWorkspace {...props}>{occurrenceView()}</CalendarWorkspace>));
    const olderDetails = [...document.querySelectorAll("details")].find((item) => item.textContent?.includes("October 5"))!;
    await act(async () => { (olderDetails.querySelector("summary") as HTMLElement).click(); });
    expect(olderDetails.classList.contains("selected")).toBe(true);
    const backButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Back to calendar") as HTMLButtonElement;
    await act(async () => backButton.click());
    expect(back).toHaveBeenCalledOnce();
    await act(async () => root!.render(<CalendarWorkspace {...props}><div /></CalendarWorkspace>));
    await act(async () => root!.render(<CalendarWorkspace {...props}>{occurrenceView()}</CalendarWorkspace>));
    expect([...document.querySelectorAll("details.selected")][0]?.textContent).toContain("October 5");
  });
});
