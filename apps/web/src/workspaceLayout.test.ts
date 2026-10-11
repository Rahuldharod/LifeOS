import { describe, expect, it } from "vitest";
import { clampListWidth, listClamps, shellLayout, workspaceBand } from "./workspaceLayout.js";

describe("responsive workspace bands (#154)", () => {
  it("measures the usable workspace, not the device", () => {
    expect(workspaceBand(759)).toBe("narrow");
    expect(workspaceBand(760)).toBe("compact");
    expect(workspaceBand(1199)).toBe("compact");
    expect(workspaceBand(1200)).toBe("standard");
    expect(workspaceBand(1799)).toBe("standard");
    expect(workspaceBand(1800)).toBe("wide");
  });

  it("subtracts the user's sidebar preference before choosing a band", () => {
    expect(shellLayout(1280, 800, false)).toEqual({ band: "compact", short: true, workspaceWidth: 1040 });
    expect(shellLayout(1280, 800, true).workspaceWidth).toBe(1204);
    expect(shellLayout(1280, 800, true).band).toBe("standard");
    expect(shellLayout(2560, 1440, false)).toEqual({ band: "wide", short: false, workspaceWidth: 2320 });
  });

  it("replaces the sidebar in the narrow band, so the workspace gets the whole viewport", () => {
    expect(shellLayout(999, 900, false)).toEqual({ band: "narrow", short: false, workspaceWidth: 999 });
    expect(shellLayout(1000, 900, false).band).toBe("compact");
    expect(shellLayout(320, 640, true)).toEqual({ band: "narrow", short: true, workspaceWidth: 320 });
  });

  it("treats height independently of width", () => {
    expect(shellLayout(1920, 899, false).short).toBe(true);
    expect(shellLayout(1920, 900, false).short).toBe(false);
  });
});

describe("list pane clamps (#154)", () => {
  it("keeps each workspace's agreed bounds", () => {
    expect(listClamps.tasks).toEqual({ min: 460, max: 640 });
    expect(listClamps.calendar).toEqual({ min: 320, max: 480 });
    expect(listClamps.reference).toEqual({ min: 320, max: 480 });
  });

  it("clamps a dragged or stored width into the workspace bounds", () => {
    expect(clampListWidth(100, "notes", 1600)).toBe(360);
    expect(clampListWidth(900, "notes", 1600)).toBe(520);
    expect(clampListWidth(430.4, "notes", 1600)).toBe(430);
  });

  it("leaves the detail pane its minimum before reaching the list maximum, but never goes below the list minimum", () => {
    expect(clampListWidth(640, "tasks", 1000)).toBe(600);
    expect(clampListWidth(640, "tasks", 700)).toBe(460);
  });
});
