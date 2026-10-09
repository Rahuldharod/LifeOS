import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { entityLinkFields } from "@lifeos/shared";
import { EntityLinkPicker, linkPickerOptions, type Linkable } from "./EntityLinkPicker.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const object = (id: string, type: string, title: string, extra: Record<string, unknown> = {}): Linkable => ({ frontmatter: { id, type, title, ...extra } });
const objects = [
  object("p1", "project", "Launch"),
  object("p2", "project", "Shelved", { archived_at: "2026-01-01T00:00:00.000Z" }),
  object("p3", "project", "Gone", { deleted_at: "2026-01-01T00:00:00.000Z" }),
  object("c1", "client", "Example Client"),
  object("a1", "person", "Ada Lovelace"),
  object("t1", "task", "This task"),
  object("t2", "task", "Other task")
];
const field = (type: keyof typeof entityLinkFields, key: string) => entityLinkFields[type].find((candidate) => candidate.key === key)!;
const noop = () => undefined;

describe("EntityLinkPicker (PB-010)", () => {
  it("offers only live objects of the field's type, never the object itself", () => {
    expect(linkPickerOptions(field("task", "primary_project_id"), objects, new Map(), "t1").map((option) => option.id)).toEqual(["p1"]);
    expect(linkPickerOptions(field("task", "dependency_ids"), objects, new Map(), "t1").map((option) => option.id)).toEqual(["t2"]);
  });

  it("renders every task relationship field as a searchable combobox", () => {
    for (const link of entityLinkFields.task) {
      const html = renderToStaticMarkup(<EntityLinkPicker field={link} value={link.multi ? [] : ""} objects={objects} labels={new Map()} selfId="t1" disabled={false} onChange={noop} />);
      expect(html).toContain('role="combobox"');
      expect(html).toContain(`aria-label="${link.label}"`);
    }
  });

  it("shows an archived link by its stored name with an archived tag", () => {
    const html = renderToStaticMarkup(<EntityLinkPicker field={field("task", "primary_project_id")} value="p2" objects={objects} labels={new Map()} selfId="t1" disabled={false} onChange={noop} />);
    expect(html).toContain('value="Shelved (archived)"');
    expect(text(html)).toContain("archived");
  });

  it("shows a deleted or unknown link with a missing tag", () => {
    const deleted = renderToStaticMarkup(<EntityLinkPicker field={field("task", "dependency_ids")} value={["t3", "p3"]} objects={[...objects, object("t3", "task", "Old blocker", { deleted_at: "2026-01-01T00:00:00.000Z" })]} labels={new Map()} selfId="t1" disabled={false} onChange={noop} />);
    expect(text(deleted)).toContain("Old blocker missing");
    expect(text(deleted)).toContain("Gone missing");
    const unknown = renderToStaticMarkup(<EntityLinkPicker field={field("client", "primary_contact_person_id")} value="zz" objects={objects} labels={new Map()} selfId="c1" disabled={false} onChange={noop} />);
    expect(unknown).toContain('value="Unknown (missing)"');
  });
});
