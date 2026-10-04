import { describe, expect, it } from "vitest";
import { externalChoiceOf, externalChoiceValue, labelMap, parseDomains, parseEmails, personLabel, personOption, type PersonLabel } from "./personLabels.js";

const labels = labelMap([
  { id: "a", name: "Kim", label: "Kim - ext", suffix: " - ext", isExternal: true, externalSource: "email" },
  { id: "b", name: "Jean Dupont", label: "Jean Dupont", isExternal: false, externalSource: "email" }
] satisfies PersonLabel[]);
const person = (id: string, title: string) => ({ frontmatter: { id, title } });

describe("person labels (#39)", () => {
  it("uses the server label, keeping the external suffix as text", () => {
    expect(personLabel(labels, person("a", "Kim Lee")).label).toBe("Kim - ext");
    expect(personOption(labels, person("a", "Kim Lee"))).toEqual({ id: "a", title: "Kim", suffix: " - ext" });
    expect(personOption(labels, person("b", "Jean Dupont"))).toEqual({ id: "b", title: "Jean Dupont" });
  });

  it("falls back to the title for an unknown person", () => {
    expect(personLabel(labels, person("x", "New Attendee"))).toEqual({ name: "New Attendee", label: "New Attendee" });
  });

  it("splits a domains field on commas, spaces and new lines", () => {
    expect(parseDomains(" example.com,example.org\nacme.fr ;  ")).toEqual(["example.com", "example.org", "acme.fr"]);
  });

  it("splits a self-email field the same way (#54)", () => {
    expect(parseEmails(" me@example.com,\nMe@example.org ;  ")).toEqual(["me@example.com", "Me@example.org"]);
  });

  it("maps the External choice to the API value and back", () => {
    expect(externalChoiceValue("auto")).toBeNull();
    expect(externalChoiceValue("external")).toBe(true);
    expect(externalChoiceValue("internal")).toBe(false);
    expect(externalChoiceOf({ is_external_override: false })).toBe("internal");
    expect(externalChoiceOf({ is_external: true })).toBe("auto");
  });
});
