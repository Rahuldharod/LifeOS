import { describe, expect, it } from "vitest";
import { lifeosLinkId, resolveLifeosLink, type LinkedObject } from "./lifeosLinks.js";

const id = (n: number) => `01a10000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const object = (n: number, type: string, extra: Record<string, unknown> = {}): LinkedObject => ({ frontmatter: { id: id(n), type, title: `Object ${n}`, ...extra } });
const objects = [object(1, "meeting-note"), object(2, "knowledge-note", { deleted_at: "2026-10-01T00:00:00Z" }), object(3, "task"), object(4, "person"), object(5, "meeting"), object(6, "decision"), object(7, "project", { archived_at: "2026-10-01T00:00:00Z" }), object(8, "review-item"), object(9, "source")];
const link = (n: number) => `lifeos://object/${id(n)}`;

describe("lifeos links", () => {
  it("reads the id from a link, tolerating case, a trailing path, query or anchor", () => {
    expect(lifeosLinkId(link(1))).toBe(id(1));
    expect(lifeosLinkId(link(1).toUpperCase().replace("LIFEOS://OBJECT", "lifeos://object"))).toBe(id(1));
    expect(lifeosLinkId(`${link(1)}#section`)).toBe(id(1));
    expect(lifeosLinkId(`${link(1)}?x=1`)).toBe(id(1));
  });
  it("ignores anything that is not a LifeOS object link", () => {
    for (const href of ["https://example.com", "lifeos://object/not-a-uuid", "lifeos://other/" + id(1), "", undefined, null]) expect(lifeosLinkId(href as string)).toBeUndefined();
    expect(resolveLifeosLink("https://example.com", objects)).toEqual({ kind: "invalid" });
  });
  it("sends notes to Notes, flagging deleted ones", () => {
    expect(resolveLifeosLink(link(1), objects)).toEqual({ kind: "note", id: id(1), deleted: false });
    expect(resolveLifeosLink(link(2), objects)).toEqual({ kind: "note", id: id(2), deleted: true });
  });
  it("sends entities, meetings and review items to their view", () => {
    expect(resolveLifeosLink(link(3), objects)).toEqual({ kind: "entity", id: id(3), view: "Tasks" });
    expect(resolveLifeosLink(link(4), objects)).toEqual({ kind: "entity", id: id(4), view: "People" });
    expect(resolveLifeosLink(link(5), objects)).toEqual({ kind: "meeting", id: id(5) });
    expect(resolveLifeosLink(link(8), objects)).toEqual({ kind: "inbox", id: id(8) });
    expect(resolveLifeosLink(link(6), objects)).toEqual({ kind: "entity", id: id(6), view: "Decisions" });
  });
  it("explains what cannot be opened", () => {
    expect(resolveLifeosLink(link(9), objects)).toEqual({ kind: "unsupported", id: id(9), type: "source" });
    expect(resolveLifeosLink(link(7), objects)).toEqual({ kind: "missing", id: id(7) });
    expect(resolveLifeosLink(link(99), objects)).toEqual({ kind: "missing", id: id(99) });
  });
});
