import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SaveStatus } from "./SaveStatus.js";

describe("SaveStatus (#68)", () => {
  it("announces a successful save politely as a status", () => {
    expect(renderToStaticMarkup(<SaveStatus status={{ kind: "saved", text: "Saved." }} />)).toBe('<small class="calendar-saved" role="status">Saved.</small>');
  });

  it("announces a failed save as an alert", () => {
    expect(renderToStaticMarkup(<SaveStatus status={{ kind: "error", text: "Could not save" }} />)).toBe('<small class="calendar-error" role="alert">Could not save</small>');
  });

  it("renders nothing when there is no status yet", () => {
    expect(renderToStaticMarkup(<SaveStatus status={undefined} />)).toBe("");
  });
});
