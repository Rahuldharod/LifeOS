import { describe, expect, it } from "vitest";
import { firstEditPeopleIds, headerPeopleIds } from "./firstEditPeople.js";

// The header shows people by Display label ("Alex"), while the event's attendee is the Person ("Alex Morgan").
const options = [{ id: "p-self", title: "Rahul" }, { id: "p-alex", title: "Alex" }, { id: "p-sam", title: "Sam" }];
const person = (id: string, title: string) => ({ frontmatter: { id, title } });

describe("a Meeting Note's People before its first edit", () => {
  it("shows every Attendee LifeOS already knows, whatever their Display label", () => {
    const attendees = [person("p-self", "Rahul Example"), person("p-alex", "Alex Morgan"), person("preview:person:e1:Nina", "Nina")];
    expect(headerPeopleIds(options, attendees)).toEqual(["p-self", "p-alex"]);
  });

  it("keeps known Attendees when the user adds someone before typing", () => {
    const shown = headerPeopleIds(options, [person("p-self", "Rahul Example"), person("p-alex", "Alex Morgan")]);
    // The first edit created Nina; the server's note lists self, Alex and Nina.
    expect(firstEditPeopleIds([...shown, "p-sam"], ["p-self", "p-alex", "p-nina"], options)).toEqual(["p-self", "p-alex", "p-sam", "p-nina"]);
  });

  it("drops a known Attendee the user removed before typing", () => {
    expect(firstEditPeopleIds(["p-self"], ["p-self", "p-alex", "p-nina"], options)).toEqual(["p-self", "p-nina"]);
  });
});
