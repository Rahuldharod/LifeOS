import { describe, expect, it } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { noteDeletePrompt } from "./noteDeletePrompt.js";

const note = (fields: Record<string, unknown> = {}): LifeObject => ({
  relativePath: "meetings/note.md", contentHash: "hash", body: "Notes", frontmatter: {
    id: "note", type: "meeting-note", title: "Weekly planning notes", revision: 1,
    created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", ...fields
  }
});

describe("noteDeletePrompt", () => {
  it("warns that deleting a recurring Meeting Note affects the whole series", () => {
    expect(noteDeletePrompt(note({ recurrence_series_id: "google:work:weekly" }), false)).toContain("whole recurring series");
  });

  it("retains the ordinary and unsaved-change warnings for one-off Notes", () => {
    const message = noteDeletePrompt(note(), true);
    expect(message).not.toContain("whole recurring series");
    expect(message).toContain("Unsaved changes");
  });
});
