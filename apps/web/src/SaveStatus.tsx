// #68: the one save-status line under a Settings card. Errors are announced as an alert, success as a polite status.
import React from "react";

export type SaveState = { kind: "saved" | "error"; text: string };

export function SaveStatus({ status }: { status: SaveState | undefined }) {
  if (!status) return null;
  return <small className={status.kind === "error" ? "calendar-error" : "calendar-saved"} role={status.kind === "error" ? "alert" : "status"}>{status.text}</small>;
}
