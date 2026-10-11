import { useEffect, useState } from "react";

/** Shared list/detail breakpoint. CSS and accessible `hidden` state must agree on the same width. */
export function useNarrowWorkspace() {
  const media = "(max-width: 760px)";
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(media).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(media); const update = () => setNarrow(query.matches);
    query.addEventListener("change", update); update();
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
