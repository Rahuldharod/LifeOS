// #97: a one-line notice that leads with the problem in bold words, then explains it (editor labels, the
// calendar offline banner). Status is said in words, never by colour alone; `className` gives the colour.
import React from "react";

export function InlineNotice({ as: Tag = "p", className, role, title, children }: { as?: "p" | "div"; className: string; role: "alert" | "status" | "note"; title: React.ReactNode; children?: React.ReactNode }) {
  return <Tag className={className} role={role}><b>{title}</b> {children}</Tag>;
}
