import { createContext, useContext, useEffect, useState } from "react";
import { detailMinWidth, listClamps, shellLayout, type ListWorkspace, type ShellLayout, type WorkspaceBand } from "./workspaceLayout.js";

/** Published by the application shell so every workspace reads the same band as the CSS. */
export const WorkspaceLayoutContext = createContext<ShellLayout | undefined>(undefined);

function viewport() {
  return typeof window === "undefined" ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight };
}

/** The shell's band and short-height state, recomputed when the window (or browser zoom) changes. */
export function useShellLayout(collapsed: boolean): ShellLayout {
  const [size, setSize] = useState(viewport);
  useEffect(() => {
    const update = () => setSize(viewport());
    window.addEventListener("resize", update); update();
    return () => window.removeEventListener("resize", update);
  }, []);
  return shellLayout(size.width, size.height, collapsed);
}

/** Outside the shell (focused component tests), fall back to the viewport media query. */
function useViewportNarrow() {
  const media = "(max-width: 759.98px)";
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(media).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(media); const update = () => setNarrow(query.matches);
    query.addEventListener("change", update); update();
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function useWorkspaceBand(): WorkspaceBand {
  const layout = useContext(WorkspaceLayoutContext);
  const narrow = useViewportNarrow();
  return layout?.band ?? (narrow ? "narrow" : "compact");
}

/** The shell layout is available to panes that need an earlier fit threshold than the global narrow band. */
export function usePublishedShellLayout() {
  return useContext(WorkspaceLayoutContext);
}

/** Shared list/detail breakpoint. CSS and accessible `hidden` state agree because both read the shell's band. */
export function useNarrowWorkspace() {
  return useWorkspaceBand() === "narrow";
}

/** Stacks a list/detail workspace before its list clamp would squeeze the 400px detail below its contract. */
export function useStackedWorkspace(workspace: ListWorkspace) {
  const layout = usePublishedShellLayout();
  const narrow = useNarrowWorkspace();
  const gutter = layout?.band === "compact" ? 24 : layout?.band === "narrow" ? 16 : 32;
  const paneWidth = layout ? layout.workspaceWidth - 2 * gutter : Infinity;
  return narrow || paneWidth < listClamps[workspace].min + detailMinWidth + 12;
}

/** Reference Data lives inside the Settings detail pane, so it must account for the outer settings rail too. */
export function useStackedReferenceInSettings() {
  const layout = usePublishedShellLayout();
  const narrow = useNarrowWorkspace();
  if (!layout) return narrow;
  const gutter = layout.band === "compact" ? 24 : layout.band === "narrow" ? 16 : 32;
  const settingsWidth = layout.workspaceWidth - 2 * gutter;
  const settingsRail = Math.min(listClamps.settings.max, Math.max(listClamps.settings.min, settingsWidth * 0.26));
  // `settings-section` has var(--space-6) (32px) padding on each side.
  const referenceWidth = settingsWidth - settingsRail - 64;
  return narrow || referenceWidth < listClamps.reference.min + detailMinWidth + 12;
}
