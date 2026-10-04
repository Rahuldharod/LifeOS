import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { changeSensitivity, SensitivityToggle, type SensitivityObject } from "./SensitivityToggle.js";

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
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    const call = async <T,>(url: string, options?: RequestInit) => { calls.push({ url, options }); return {} as T; };
    await changeSensitivity(object(), "decision", call);
    await changeSensitivity(object("restricted"), "decision", call);
    expect(calls.map((entry) => entry.url)).toEqual(["/api/v1/objects/0190a1b2-0000-7000-8000-000000000001/sensitivity", "/api/v1/objects/0190a1b2-0000-7000-8000-000000000001/sensitivity"]);
    expect(calls.map((entry) => entry.options?.method)).toEqual(["POST", "POST"]);
    expect(calls.map((entry) => JSON.parse(String(entry.options?.body)))).toEqual([{ sensitivity: "restricted", expectedHash: "hash-1" }, { sensitivity: "normal", expectedHash: "hash-1" }]);
  });

  it("explains a conflict in plain words instead of the raw hash error", async () => {
    const call = async () => { throw new ApiError("Expected content hash abc but found def", 409); };
    await expect(changeSensitivity(object(), "open point", call)).rejects.toThrow("This open point was changed elsewhere, so its sensitivity was not changed. The latest version is loaded; try again.");
  });

  it("passes other errors through unchanged", async () => {
    const call = async () => { throw new ApiError("LifeOS server is not reachable", 0); };
    await expect(changeSensitivity(object(), "meeting", call)).rejects.toThrow("LifeOS server is not reachable");
  });
});
