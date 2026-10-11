// The responsive contract (#154): bands follow the usable workspace width after the sidebar, not named devices,
// and a short-height treatment applies independently. The shell publishes the result as data-band / data-height
// so CSS and the accessible `hidden` state of list/detail panes always agree.
export type WorkspaceBand = "narrow" | "compact" | "standard" | "wide";
export type ShellLayout = { band: WorkspaceBand; short: boolean; workspaceWidth: number };

export const bandStarts = { compact: 760, standard: 1200, wide: 1800 } as const;
export const shortHeightBelow = 900;
/** Must match --sidebar-width and --sidebar-width-collapsed in design-tokens.css. */
export const sidebarWidth = { expanded: 240, collapsed: 76 } as const;

export function workspaceBand(width: number): WorkspaceBand {
  if (width < bandStarts.compact) return "narrow";
  if (width < bandStarts.standard) return "compact";
  if (width < bandStarts.wide) return "standard";
  return "wide";
}

/**
 * The band is decided with the sidebar the user prefers. In the narrow band the sidebar becomes a top bar, so the
 * workspace then gets the whole viewport while staying in the narrow band (it never flips back and forth).
 */
export function shellLayout(viewportWidth: number, viewportHeight: number, collapsed: boolean): ShellLayout {
  const besideSidebar = viewportWidth - (collapsed ? sidebarWidth.collapsed : sidebarWidth.expanded);
  const band = workspaceBand(besideSidebar);
  return { band, short: viewportHeight < shortHeightBelow, workspaceWidth: band === "narrow" ? viewportWidth : besideSidebar };
}

export type ListWorkspace = "tasks" | "calendar" | "notes" | "inbox" | "decisions" | "openPoints" | "knowledge" | "settings" | "reference";

/** List widths are content-specific clamps, never permanent percentages. */
export const listClamps: Record<ListWorkspace, { min: number; max: number }> = {
  tasks: { min: 460, max: 640 },
  calendar: { min: 320, max: 480 },
  notes: { min: 360, max: 520 },
  inbox: { min: 380, max: 520 },
  decisions: { min: 380, max: 560 },
  openPoints: { min: 380, max: 560 },
  knowledge: { min: 360, max: 520 },
  settings: { min: 240, max: 320 },
  reference: { min: 320, max: 480 }
};

/** The detail pane keeps at least this much before the list may grow towards its maximum. */
export const detailMinWidth = 400;

export function clampListWidth(width: number, workspace: ListWorkspace, containerWidth: number) {
  const { min, max } = listClamps[workspace];
  const roomy = Math.max(min, Math.min(max, containerWidth - detailMinWidth));
  return Math.round(Math.min(Math.max(width, min), roomy));
}
