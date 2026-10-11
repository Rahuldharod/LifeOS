import { createContext, useContext, useEffect, useState } from "react";
import { shellLayout, type ShellLayout, type WorkspaceBand } from "./workspaceLayout.js";

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

/** Shared list/detail breakpoint. CSS and accessible `hidden` state agree because both read the shell's band. */
export function useNarrowWorkspace() {
  return useWorkspaceBand() === "narrow";
}
