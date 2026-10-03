import { describe, expect, it } from "vitest";
import { noteDetailsChanges, noteDetailsForm } from "./noteDetailsForm.js";

const meetingNote = { title: "Weekly", type: "meeting-note", primary_project_id: "p1", people_ids: ["a", "b"] };

describe("note details form", () => {
  it("reads the saved relationships, treating missing ones as empty", () => {
    expect(noteDetailsForm(meetingNote)).toEqual({ title: "Weekly", projectId: "p1", clientId: "", productId: "", peopleIds: ["a", "b"] });
  });

  it("sends nothing when nothing moved, whatever the order of people", () => {
    const form = { ...noteDetailsForm(meetingNote), peopleIds: ["b", "a"] };
    expect(noteDetailsChanges(meetingNote, form)).toEqual({});
  });

  it("sends only the changed fields and turns an emptied link into null", () => {
    const form = { ...noteDetailsForm(meetingNote), title: " Renamed ", projectId: "", clientId: "c1" };
    expect(noteDetailsChanges(meetingNote, form)).toEqual({ title: "Renamed", primary_project_id: null, primary_client_id: "c1" });
  });

  it("never sends people for a knowledge note", () => {
    const knowledge = { title: "Idea", type: "knowledge-note" };
    expect(noteDetailsChanges(knowledge, { ...noteDetailsForm(knowledge), peopleIds: ["a"] })).toEqual({});
  });
});
