// Display formatting for stored UTC instants, in the device's chosen display timezone (moved out of main.tsx, #68).
export function formatDate(value: unknown) {
  if (typeof value !== "string") return "—";
  const timeZone = localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone }); }
  catch { return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
}

/** Time only, for list items whose day is already shown in a group header (PB-023). */
export function formatTime(value: unknown) {
  if (typeof value !== "string") return "—";
  const timeZone = localStorage.getItem("lifeos.displayTimeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { return new Date(value).toLocaleTimeString([], { timeStyle: "short", timeZone }); }
  catch { return new Date(value).toLocaleTimeString([], { timeStyle: "short" }); }
}
