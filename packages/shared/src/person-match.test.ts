import { describe, expect, it } from "vitest";
import { emailFitsName, emailNameMatch, isUnreviewedPerson } from "./person-match.js";

describe("emailFitsName", () => {
  it.each([
    ["john.doe@example.com", "first.last"],
    ["johndoe@example.com", "firstlast"],
    ["john_doe@example.com", "first_last"],
    ["jdoe@example.com", "flast"],
    ["John.Doe+news@example.com", "first.last"]
  ])("%s fits John Doe as %s", (email, kind) => expect(emailFitsName(email, "John Doe")).toBe(kind));

  it("ignores accents, case and hyphens in the family name", () => {
    expect(emailFitsName("lea.martindubois@example.com", "Léa Martin-Dubois")).toBe("first.last");
    expect(emailFitsName("lea.martin-dubois@example.com", "LÉA Martin-Dubois")).toBe("first.last");
  });

  it("does not fit a single name, a first name alone or another family name", () => {
    expect(emailFitsName("john@example.com", "John Doe")).toBeUndefined();
    expect(emailFitsName("john.smith@example.com", "John Doe")).toBeUndefined();
    expect(emailFitsName("john.doe@example.com", "John")).toBeUndefined();
  });
});

describe("emailNameMatch", () => {
  const john = { id: "john", names: ["John Doe"] }, jane = { id: "jane", names: ["Jane Doe"] };
  it("accepts flast only for the one live person it fits", () => {
    expect(emailNameMatch("jdoe@example.com", john, [john])).toBe("flast");
    expect(emailNameMatch("jdoe@example.com", john, [john, jane])).toBeUndefined();
    expect(emailNameMatch("john.doe@example.com", john, [john, jane])).toBe("first.last");
  });
});

describe("isUnreviewedPerson", () => {
  it("covers explicit review state and automatic origins without one, never the user's own or the self person", () => {
    expect(isUnreviewedPerson({ review_state: "unreviewed", origin: "user-dictated" })).toBe(true);
    expect(isUnreviewedPerson({ origin: "calendar" })).toBe(true);
    expect(isUnreviewedPerson({ origin: "agent-extracted" })).toBe(true);
    expect(isUnreviewedPerson({ origin: "calendar", review_state: "reviewed" })).toBe(false);
    expect(isUnreviewedPerson({ origin: "app" })).toBe(false);
    expect(isUnreviewedPerson({ origin: "calendar", is_self: true })).toBe(false);
  });
});
