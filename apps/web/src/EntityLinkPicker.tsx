// A relationship field on the Tasks, Projects, Clients, Products and People forms (PB-010): a
// searchable picker over live objects of the field's type. A stored link whose target is now
// archived or deleted is shown by its stored name with a tag and kept until the user changes it.
import React from "react";
import type { EntityLinkField } from "@lifeos/shared";
import type { PersonLabel } from "@lifeos/contracts";
import { personOption } from "./personLabels.js";
import { SearchSelect } from "./SearchSelect.js";
import type { SearchOption } from "./searchOptions.js";

/** Any indexed object, deleted and archived ones included (the `/api/v1/objects` listing), so stored names can be shown. */
export type Linkable = { frontmatter: Record<string, unknown> & { id: string; type: string; title: string } };

const isLive = (object: Linkable) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;

/** The objects a field may newly link to: live, of the field's type, and never the object being edited. */
export function linkPickerOptions(field: EntityLinkField, objects: Linkable[], labels: Map<string, PersonLabel>, selfId: string): SearchOption[] {
  return objects
    .filter((object) => object.frontmatter.type === field.target && isLive(object) && object.frontmatter.id !== selfId)
    .map((object) => field.target === "person" ? personOption(labels, object) : { id: object.frontmatter.id, title: object.frontmatter.title });
}

/** Label for a stored value that is not offered: its stored name, tagged "archived" or "missing". */
function describeStored(field: EntityLinkField, objects: Linkable[], id: string): SearchOption {
  const object = objects.find((candidate) => candidate.frontmatter.id === id);
  if (!object) return { id, title: "Unknown", tag: "missing" };
  const tag = object.frontmatter.type === field.target && !object.frontmatter.deleted_at && object.frontmatter.archived_at ? "archived" : "missing";
  return { id, title: object.frontmatter.title, tag };
}

export function EntityLinkPicker({ field, value, objects, labels, selfId, disabled, onChange }: {
  field: EntityLinkField;
  value: unknown;
  objects: Linkable[];
  labels: Map<string, PersonLabel>;
  selfId: string;
  disabled: boolean;
  /** `null` clears a single link; the server removes it on save. */
  onChange: (value: string | string[] | null) => void;
}) {
  const options = linkPickerOptions(field, objects, labels, selfId);
  const describe = (id: string) => describeStored(field, objects, id);
  if (field.multi) {
    const ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    return <SearchSelect multi label={field.label} options={options} describe={describe} value={ids} disabled={disabled} onChange={onChange} />;
  }
  return <SearchSelect label={field.label} options={options} describe={describe} clearable={!field.required} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(next) => onChange(next || null)} />;
}
