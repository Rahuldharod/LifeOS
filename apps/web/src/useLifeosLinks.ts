// `lifeos://object/<id>` links (PB-007): the click listener that catches them in every editor mode and the
// `openLifeosLink` that App also hands to Decisions, Open Points and the copy-link feature. App supplies
// the pieces that belong to it (leaving the editors, routing, the status line); this decides where a link goes.
import { useEffect, useRef } from "react";
import type { LifeObject, ObjectLink } from "@lifeos/contracts";
import { dateInTimeZone } from "./zonedTime.js";
import { lifeosLinkId, resolveLifeosLink } from "./lifeosLinks.js";
import type { Route } from "./routes.js";

export type UseLifeosLinksOptions = {
  /** Saves the open note first; false means the user stayed, so the link must not open. */
  leaveEditors: () => Promise<boolean>;
  /** Fetched fresh so a link to something created a moment ago still works. */
  refreshObjectLinks: () => Promise<ObjectLink[]>;
  refreshNoteLists: () => Promise<{ open: LifeObject[]; deleted: LifeObject[] }>;
  /** PB-027: each link opened is a history entry. */
  followRoute: (route: Route) => void;
  onMessage: (text: string) => void;
  /** The Calendar day a meeting link falls back to when the meeting has no start time. */
  selectedDate: string;
  displayTimeZone: string;
  /** A note link clears the notes search so the note is visible in the list. */
  onNoteOpened: () => void;
  /** An entity card to flash, also when the link points at the card already shown (no URL change). */
  onHighlight: (id: string) => void;
};

export type LifeosLinks = { openLifeosLink: (href: string) => Promise<void> };

export function useLifeosLinks(options: UseLifeosLinksOptions): LifeosLinks {
  const latest = useRef(options);
  latest.current = options;

  const openLifeosLink = async (href: string) => {
    const { leaveEditors, refreshObjectLinks, refreshNoteLists, followRoute, onMessage, selectedDate, displayTimeZone, onNoteOpened, onHighlight } = latest.current;
    try {
      if (!(await leaveEditors())) return;
      const objects = await refreshObjectLinks();
      const target = resolveLifeosLink(href, objects);
      if (target.kind === "invalid") return;
      if (target.kind === "missing") { onMessage("That linked object no longer exists."); return; }
      if (target.kind === "unsupported") { onMessage(`Opening a ${target.type.replace("-", " ")} from a link is not supported yet.`); return; }
      if (target.kind === "note") {
        const { open, deleted } = await refreshNoteLists();
        onNoteOpened();
        const live = open.find((note) => note.frontmatter.id === target.id);
        const gone = deleted.find((note) => note.frontmatter.id === target.id);
        if (!live && !gone) { onMessage("That linked note no longer exists."); return; }
        followRoute({ view: "Notes", noteTab: live ? "open" : "deleted", id: target.id });
      } else if (target.kind === "meeting") {
        const meeting = objects.find((object) => object.frontmatter.id === target.id);
        const date = meeting?.frontmatter.starts_at ? dateInTimeZone(new Date(String(meeting.frontmatter.starts_at)), displayTimeZone) : selectedDate;
        followRoute({ view: "Calendar", date, id: target.id });
      } else if (target.kind === "inbox") {
        followRoute({ view: "Inbox", id: target.id });
      } else {
        followRoute({ view: target.view, id: target.id });
        // The same card again (no URL change) still flashes.
        onHighlight(target.id);
      }
    } catch (error) {
      latest.current.onMessage(error instanceof Error ? error.message : "Could not open the link");
    }
  };

  // The click listener is attached once; it calls whichever handler the latest render created.
  const handler = useRef(openLifeosLink);
  handler.current = openLifeosLink;
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest?.("a[href], a[data-lifeos-href]");
      if (!anchor) return;
      // The editor's link bubble shows the raw address as its text, with an emptied href (PB-007).
      const href = anchor.getAttribute("data-lifeos-href") ?? (anchor.closest(".milkdown-link-preview") ? anchor.textContent : anchor.getAttribute("href"));
      if (!lifeosLinkId(href)) return;
      // The browser cannot open lifeos:// itself, so it must never follow the link (an emptied href
      // would open this page again in a new tab). One click opens the object, in every mode.
      event.preventDefault();
      event.stopPropagation();
      void handler.current(href!.trim());
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return { openLifeosLink };
}
