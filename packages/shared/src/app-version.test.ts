import { describe, expect, it } from "vitest";
import { appVersion, type MainCommit } from "./app-version.js";

// Main's first-parent history, newest first, as git log prints it.
const main: MainCommit[] = [
  { commit: "c3c3c3c3c3c3", committedAt: "2026-10-14T16:00:00+02:00" },
  { commit: "b2b2b2b2b2b2", committedAt: "2026-10-14T11:00:00+02:00" },
  { commit: "a1a1a1a1a1a1", committedAt: "2026-10-14T09:00:00+02:00" },
  { commit: "9f9f9f9f9f9f", committedAt: "2026-10-13T18:00:00+02:00" }
];
const release = (history: MainCommit[], base = history[0]!.commit) => appVersion({ main: history, base, buildCommit: base });

describe("App version", () => {
  it("numbers a merge by its place in the Paris day", () => {
    expect(release(main)).toBe("26.10.14.3");
  });

  it("shows .1 on a day's first merge", () => {
    expect(release(main, "a1a1a1a1a1a1")).toBe("26.10.14.1");
  });

  it("numbers the build's own main merge when main has moved on since", () => {
    expect(release(main, "b2b2b2b2b2b2")).toBe("26.10.14.2");
  });

  it("counts a merge at 23:30 UTC on the next Paris day", () => {
    expect(release([{ commit: "d4d4d4d4d4d4", committedAt: "2026-10-14T23:30:00Z" }, ...main])).toBe("26.10.15.1");
  });

  it("uses the Paris day on the night the clocks go back", () => {
    // 25 Oct 2026: 00:30 UTC is 02:30 Paris summer time; 23:30 UTC that evening is 00:30 on the 26th (winter time).
    const history = [
      { commit: "f6f6f6f6f6f6", committedAt: "2026-10-25T23:30:00Z" },
      { commit: "e5e5e5e5e5e5", committedAt: "2026-10-25T00:30:00Z" },
      { commit: "e4e4e4e4e4e4", committedAt: "2026-10-24T22:30:00Z" }
    ];
    expect(release(history)).toBe("26.10.26.1");
    expect(release(history, "e5e5e5e5e5e5")).toBe("26.10.25.2");
  });

  it("uses the Paris day on the night the clocks go forward", () => {
    // 29 Mar 2026: 23:30 UTC on the 28th is 00:30 on the 29th (winter time); 22:30 UTC on the 29th is 00:30 on the 30th (summer time).
    const history = [
      { commit: "h8h8h8h8h8h8", committedAt: "2026-03-29T22:30:00Z" },
      { commit: "g7g7g7g7g7g7", committedAt: "2026-03-29T21:30:00Z" },
      { commit: "g6g6g6g6g6g6", committedAt: "2026-03-28T23:30:00Z" }
    ];
    expect(release(history)).toBe("26.03.30.1");
    expect(release(history, "g7g7g7g7g7g7")).toBe("26.03.29.2");
  });

  it("pads month and day so versions sort as text", () => {
    expect(release([{ commit: "a0a0a0a0a0a0", committedAt: "2027-01-05T10:00:00+01:00" }])).toBe("27.01.05.1");
  });

  it("marks a build that is not a main merge with -dev and its short commit", () => {
    expect(appVersion({ main, base: "c3c3c3c3c3c3", buildCommit: "abc1234def5678" })).toBe("26.10.14.3-dev+abc1234");
  });

  it("marks a dev runtime build of a main merge", () => {
    expect(appVersion({ main, base: "c3c3c3c3c3c3", buildCommit: "c3c3c3c3c3c3", dev: true })).toBe("26.10.14.3-dev+c3c3c3c");
  });

  it("is unknown without main's history, when the base is not on main, or in a shallow clone", () => {
    expect(appVersion({ main: [], base: "abc1234", buildCommit: "abc1234" })).toBe("unknown");
    expect(appVersion({ main, base: "0000000", buildCommit: "0000000" })).toBe("unknown");
    expect(appVersion({ main, base: "c3c3c3c3c3c3", buildCommit: "c3c3c3c3c3c3", shallow: true })).toBe("unknown");
  });
});
