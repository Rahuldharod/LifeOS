// #97: the amber warning card shared by the setup, backup and similar warnings on Today and System Health.
// Words carry the message (never colour alone): an upper-case label, a heading, then details and actions.
import React from "react";

export function WarningCard({ label, title, role, children }: { label: string; title?: React.ReactNode; role?: "alert" | "status"; children?: React.ReactNode }) {
  return <article className="warning-card" role={role}><span>{label}</span>
    {title !== undefined && <h3>{title}</h3>}
    {children}
  </article>;
}
