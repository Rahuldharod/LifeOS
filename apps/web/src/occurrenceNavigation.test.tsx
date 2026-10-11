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

  it("renders distinct shared-note anchors in stored newest-first order", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const markdown = '## Weekly — 2026-10-12\n<a id="occurrence-12"></a>\n\nNewer user notes\n\n## Weekly — 2026-10-05\n<a id="occurrence-5"></a>\n\nOlder user notes';
    act(() => root!.render(<OccurrenceAnchoredMarkdown markdown={markdown} render={(chunk, key) => <p key={key}>{chunk}</p>} />));

    const newer = document.getElementById("occurrence-12")!;
    const older = document.getElementById("occurrence-5")!;
    expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).toContain("Newer user notes");
    expect(document.body.textContent).toContain("Older user notes");
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
