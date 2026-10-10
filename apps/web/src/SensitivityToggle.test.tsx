import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { fakeApi, type FakeCallInput } from "./fakeApi.js";
import { changeSensitivity, SensitivityToggle, sensitivityToast, type SensitivityObject } from "./SensitivityToggle.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = async () => true;
const object = (sensitivity?: string): SensitivityObject => ({ frontmatter: { id: "0190a1b2-0000-7000-8000-000000000001", ...(sensitivity ? { sensitivity } : {}) }, contentHash: "hash-1" });

describe("SensitivityToggle (#86)", () => {
  for (const noun of ["decision", "open point", "meeting"]) {
    it(`offers "Mark restricted" on a normal ${noun}, with the state in words and no lock badge`, () => {
      const html = renderToStaticMarkup(<SensitivityToggle object={object()} noun={noun} disabled={false} run={noop} onChanged={async () => undefined} />);
      expect(text(html)).toContain("Sensitivity: Normal");
      expect(html).toMatch(/<button type="button"[^>]*>Mark restricted<\/button>/);
      expect(html).toContain(`aria-label="Sensitivity of this ${noun}"`);
      expect(html).not.toContain("lock-badge");
    });

    it(`offers "Mark normal" on a restricted ${noun} and shows the lock badge`, () => {
      const html = renderToStaticMarkup(<SensitivityToggle object={object("restricted")} noun={noun} disabled={false} run={noop} onChanged={async () => undefined} />);
      expect(text(html)).toContain("Sensitivity: Restricted");
      expect(html).toContain("lock-badge");
      expect(html).toMatch(/<button type="button"[^>]*>Mark normal<\/button>/);
    });
  }

  it("disables the button when writes are not allowed", () => {
    const html = renderToStaticMarkup(<SensitivityToggle object={object()} noun="decision" disabled run={noop} onChanged={async () => undefined} />);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Mark restricted<\/button>/);
  });

  it("shows an extra note in words when something else already restricts the object", () => {
    const html = renderToStaticMarkup(<SensitivityToggle object={object()} noun="meeting" note="Its note is restricted, so this meeting is kept away from Agents too." disabled={false} run={noop} onChanged={async () => undefined} />);
    expect(text(html)).toContain("Its note is restricted, so this meeting is kept away from Agents too.");
  });
});

describe("changeSensitivity (#86)", () => {
  it("flips the value with a guarded write to the sensitivity endpoint", async () => {
    const calls: Array<{ endpoint: string; input?: FakeCallInput }> = [];
    const call = fakeApi((endpoint, input) => { calls.push({ endpoint, input }); return {}; });
    await changeSensitivity(object(), "decision", call);
    await changeSensitivity(object("restricted"), "decision", call);
    const id = "0190a1b2-0000-7000-8000-000000000001";
    expect(calls).toEqual([
      { endpoint: "POST /api/v1/objects/:id/sensitivity", input: { params: { id }, body: { sensitivity: "restricted", expectedHash: "hash-1" } } },
      { endpoint: "POST /api/v1/objects/:id/sensitivity", input: { params: { id }, body: { sensitivity: "normal", expectedHash: "hash-1" } } }
    ]);
  });

  it("explains a conflict in plain words instead of the raw hash error", async () => {
    const call = fakeApi(() => { throw new ApiError("Expected content hash abc but found def", 409); });
    await expect(changeSensitivity(object(), "open point", call)).rejects.toThrow("This open point was changed elsewhere, so its sensitivity was not changed. The latest version is loaded; try again.");
  });

  it("passes other errors through unchanged", async () => {
    const call = fakeApi(() => { throw new ApiError("LifeOS server is not reachable", 0); });
    await expect(changeSensitivity(object(), "meeting", call)).rejects.toThrow("LifeOS server is not reachable");
  });
});

describe("sensitivityToast (#86, #92)", () => {
  it("says what the change does", () => {
    expect(sensitivityToast(false, "decision")).toBe("Marked restricted: this decision is kept away from Agents");
    expect(sensitivityToast(true, "decision")).toBe("Marked normal: this decision can be shared with Agents again");
  });

  it("says a meeting stays excluded when its note is still restricted (#63)", () => {
    expect(sensitivityToast(true, "meeting", true)).toBe("Marked normal, but this meeting stays kept away from Agents and Work Orders because its note is restricted");
    expect(sensitivityToast(false, "meeting", true)).toBe("Marked restricted: this meeting is kept away from Agents");
  });
});
