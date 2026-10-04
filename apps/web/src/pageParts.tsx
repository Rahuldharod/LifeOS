// Small pieces shared by several pages (moved out of main.tsx, #68).
import React from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { formatDate } from "./dateFormat.js";

type ListObject = { frontmatter: Record<string, unknown> & { id: string; title: string; type: string; status?: string; updated_at: string } };

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p className="lede">{description}</p></header>;
}
export function Summary({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
export const objectRow = (object: ListObject) => <div className="object-row" key={object.frontmatter.id}><i /><div><b>{object.frontmatter.title}<LockBadge frontmatter={object.frontmatter} /></b><small>{object.frontmatter.status ?? object.frontmatter.type} · Updated {formatDate(object.frontmatter.updated_at)}</small></div></div>;
