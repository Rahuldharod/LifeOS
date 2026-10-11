// @vitest-environment happy-dom
// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyFocus, LifeObject, Today, TodayPanels } from "@lifeos/contracts";
import { TodayPage } from "./TodayPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (id: string, title: string): LifeObject => ({
  relativePath: `tasks/${id}.md`, contentHash: `hash-${id}`, body: "",
  frontmatter: { schema_version: 1, revision: 1, id, type: "task", title, area: "Work", sensitivity: "normal", status: "Next", created_at: "2026-10-11T08:00:00.000Z", updated_at: "2026-10-11T08:00:00.000Z" }
});
const focus = (top3: LifeObject[]): DailyFocus => ({
  date: "2026-10-11", top3Source: "rule", maxMustDos: 3, iOwe: [], waitingAndDecisions: [], meetingPrep: [], deferCandidates: [], dismissedTop3: [], restrictedHidden: 0,
  top3: top3.map((object) => ({ id: object.frontmatter.id, object, state: "open", whyToday: "High priority" }))
});
const today = (top3: LifeObject[] = []): Today => ({ tasks: top3, overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 2, focus: focus(top3) });
const panels = (overrides: Partial<TodayPanels> = {}): TodayPanels => ({
  date: "2026-10-11", overdue: [], dueToday: [], upcomingHighPriority: [], waitingByPerson: [],
  nextMeetings: [{ title: "Autumn launch", startsAt: "2026-10-11T09:30:00.000Z", endsAt: "2026-10-11T10:15:00.000Z", inProgress: false, meetingId: "m1", restricted: false }],
  meetingHours: 0.75, meetingHeavy: false, openPointsForMeetings: [], reviewCount: 2,
  inbox: { awaiting: 0, drafts: 0, patches: 0 }, failedDrafts: [], staleWorkOrders: [],
  settings: { meetingHoursThreshold: 5, briefTime: "06:00", briefTimeZone: "Europe/Paris", briefDays: ["mon"] }, ...overrides
});
const base = {
  enrichment: { proposedGaveUp: [], staleWorkOrders: [] }, eventCount: 1, capture: "", busy: false, readOnly: false,
  onCaptureChange: vi.fn(), onCapture: vi.fn(), onReplan: vi.fn(async () => undefined), onChangeFocus: vi.fn(async () => undefined),
  onEnrich: vi.fn(async () => undefined), onGiveUp: vi.fn(async () => true), onOpenInbox: vi.fn(), onOpenSettingsCard: vi.fn()
};

describe("priority-first Today (#132)", () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

  it("keeps the effective Top 3 primary with next meeting and Quick Capture beside it", () => {
    act(() => root.render(<TodayPage {...base} today={today([task("t1", "Prepare proposal")])} panels={panels()} />));
    const priority = host.querySelector(".today-priority-grid")!;
    expect(priority.textContent).toContain("Prepare proposal");
    expect(priority.textContent).toContain("Autumn launch");
    expect(priority.textContent).toContain("QUICK CAPTURE");
    expect(host.textContent!.indexOf("TOP 3")).toBeLessThan(host.textContent!.indexOf("ACTIVE TASKS"));
  });

  it("shows Complete and More on every Top 3 row, with override actions inside More", async () => {
    const complete = vi.fn(async () => undefined);
    act(() => root.render(<TodayPage {...base} today={today([task("t1", "Prepare proposal")])} panels={panels()} onCompleteTask={complete} />));
    const row = host.querySelector(".top-three-row")!;
    expect(row.querySelector("button")?.textContent).toBe("Complete");
    expect(row.querySelector("summary")?.textContent).toBe("More");
    expect(row.querySelector("details")?.textContent).toContain("Pin");
    expect(row.querySelector("details")?.textContent).toContain("Replace");
    expect(row.querySelector("details")?.textContent).toContain("Dismiss");
    await act(async () => { (row.querySelector("button") as HTMLButtonElement).click(); });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "t1" }) }));
    await act(async () => { (row.querySelector("button[aria-label='Dismiss Prepare proposal for today']") as HTMLButtonElement).click(); });
    expect(base.onChangeFocus).toHaveBeenCalledWith({ action: "dismiss", taskId: "t1" });
  });

  it("uses stable skeletons while loading", () => {
    act(() => root.render(<TodayPage {...base} today={{ tasks: [], overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 0 }} loading />));
    expect(host.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(host.querySelectorAll(".today-skeleton-line")).toHaveLength(6);
    expect(host.textContent).toContain("Loading today");
  });

  it("gives empty priorities and meetings purpose-specific actions", async () => {
    const openTasks = vi.fn(); const openCalendar = vi.fn();
    act(() => root.render(<TodayPage {...base} today={today()} panels={panels({ nextMeetings: [] })} onOpenTasks={openTasks} onOpenCalendar={openCalendar} />));
    expect(host.textContent).toContain("No active commitments to rank");
    expect(host.textContent).toContain("No more meetings today");
    await act(async () => { (host.querySelector("button[aria-label='Open Tasks to plan today']") as HTMLButtonElement).click(); });
    await act(async () => { (host.querySelector("button[aria-label='Open Calendar']") as HTMLButtonElement).click(); });
    expect(openTasks).toHaveBeenCalledOnce(); expect(openCalendar).toHaveBeenCalledOnce();
  });

  it("keeps warning workflows visible below the priority area", () => {
    act(() => root.render(<TodayPage {...base} today={today()} panels={panels({
      calendarOffline: { reason: "network", error: "offline" },
      backupWarning: { kind: "backup-failed", message: "Latest backup failed", reason: "Disk unavailable" }
    })} onRetryCalendar={vi.fn()} onBackUpNow={vi.fn()} />));
    expect(host.textContent).toContain("Latest backup failed");
    expect(host.textContent).toContain("Offline: showing meetings already in LifeOS");
    expect(host.querySelector(".today-priority-grid")!.compareDocumentPosition(host.querySelector(".today-warning-stack")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps all write actions visible but disabled when read-only", () => {
    act(() => root.render(<TodayPage {...base} today={today([task("t1", "Prepare proposal")])} panels={panels()} readOnly onCompleteTask={vi.fn()} />));
    expect(host.textContent).toContain("Read-only: viewing today without changing it");
    for (const label of ["Refresh", "Complete", "Capture"]) {
      const control = [...host.querySelectorAll<HTMLButtonElement>(".today-priority-grid button")].find((button) => button.textContent === label);
      expect(control?.disabled).toBe(true);
    }
  });
});
