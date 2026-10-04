import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CappedRows, GiveUpRow, LivePanel, WaitingGroupRow } from "./TodayLists.js";

const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ frontmatter: { id, title, ...extra } });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Today lists (#64)", () => {
  it("shows at most 7 rows, then a real 'show more' button that states the hidden count", () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    const html = renderToStaticMarkup(<CappedRows items={items} row={(item) => <p key={item}>row {item}</p>} />);
    expect(html.match(/<p>/g)).toHaveLength(6);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*>Show 4 more<\/button>/);
    expect(renderToStaticMarkup(<CappedRows items={[1, 2, 3, 4, 5, 6, 7]} row={(item) => <p key={item}>{item}</p>} />)).not.toContain("<button");
  });

  it("caps live panels the same way and names the count in text", () => {
    const html = renderToStaticMarkup(<LivePanel title="Overdue" items={Array.from({ length: 9 }, (_, index) => index)} empty="None" row={(item) => <p key={item}>{item}</p>} />);
    expect(html).toContain("OVERDUE · 9");
    expect(html).toContain("Show 3 more");
  });

  it("renders 'Waiting by person' with the standard person label and one row per task, each with the lock badge when restricted", () => {
    const html = renderToStaticMarkup(<WaitingGroupRow group={{ personId: "p1", name: "Joel", suffix: " - ext", label: "Joel - ext", isExternal: true, tasks: [task("t1", "Signed DPA", { sensitivity: "restricted" }), task("t2", "Pilot data")] }} />);
    expect(html).toContain('<span class="person-name">Joel<span class="ext-suffix"');
    expect(html.match(/class="object-row"/g)).toHaveLength(2);
    expect(text(html)).toContain("Signed DPA 🔒 Restricted");
    expect(text(html)).not.toContain("Pilot data 🔒");
    expect(text(html)).toContain("2 waiting");
  });

  it("gives each 'Give up' button a unique accessible name that includes the meeting title", () => {
    const html = renderToStaticMarkup(<>{[{ meetingId: "m1", title: "Carrefour QBR" }, { meetingId: "m2", title: "Pilot kickoff" }].map((meeting) => <GiveUpRow key={meeting.meetingId} meeting={meeting} disabled={false} onGiveUp={() => undefined} />)}</>);
    expect(html).toContain('aria-label="Give up waiting for material from Carrefour QBR"');
    expect(html).toContain('aria-label="Give up waiting for material from Pilot kickoff"');
  });
});
