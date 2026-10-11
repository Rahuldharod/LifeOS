// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OccurrenceAnchoredMarkdown, occurrenceHeading, scrollVisualOccurrence } from "./occurrenceNavigation.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("recurring occurrence navigation", () => {
  it("exposes an exact section target in Preview's default browser DOM", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(<OccurrenceAnchoredMarkdown markdown={'## Weekly — 2026-10-05\n<a id="occurrence-5"></a>\n\nNotes'} render={(chunk, key) => <p key={key}>{chunk}</p>} />));
    expect(document.getElementById("occurrence-5")?.getAttribute("aria-label")).toBe("Linked occurrence");
  });

  it("binds and scrolls the matching Visual-mode heading", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const heading = host.appendChild(document.createElement("h2"));
    heading.textContent = "Weekly — 2026-10-05";
    heading.scrollIntoView = vi.fn();
    const markdown = '## Weekly — 2026-10-05\n<a id="occurrence-5"></a>\n\nNotes';
    expect(occurrenceHeading(markdown, "occurrence-5")).toBe("Weekly — 2026-10-05");
    expect(scrollVisualOccurrence(host, markdown, "occurrence-5")).toBe(true);
    expect(heading.id).toBe("occurrence-5");
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
});
