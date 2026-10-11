import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { OverlayDialog } from "./OverlayDialog.js";
import type { View } from "./routes.js";
import { useShellLayout, WorkspaceLayoutContext } from "./useNarrowWorkspace.js";

export const navigationCollapsedKey = "lifeos.navigation.collapsed";

const daily = ["Today", "Calendar", "Tasks", "Notes", "Inbox"] as const satisfies readonly View[];
const knowledge = ["Decisions", "Open Points", "Knowledge"] as const satisfies readonly View[];

type ShellDestination = (typeof daily)[number] | (typeof knowledge)[number] | "System" | "Settings";
type ShellIconName = ShellDestination | "Search" | "Capture" | "Collapse" | "Expand" | "Menu";

function ShellIcon({ name }: { name: ShellIconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const shape = (() => {
    switch (name) {
      case "Today": return <><path d="M4 6.5h16v13H4z" /><path d="M8 3v6M16 3v6M4 11h16" /><path d="m9 15 2 2 4-4" /></>;
      case "Calendar": return <><path d="M4 6.5h16v13H4z" /><path d="M8 3v6M16 3v6M4 11h16" /></>;
      case "Tasks": return <><path d="m4 7 2 2 3-4" /><path d="M11 7h9" /><path d="m4 15 2 2 3-4" /><path d="M11 15h9" /></>;
      case "Notes": return <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h4M9 12h7M9 16h7" /></>;
      case "Inbox": return <><path d="M4 5h16v14H4z" /><path d="M4 13h5l2 3h2l2-3h5" /></>;
      case "Decisions": return <><path d="M12 3v18M12 7H7l-3 4h8M12 11h5l3 4h-8" /></>;
      case "Open Points": return <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.9.4-.9 1-.9 1.7M12 17h.01" /></>;
      case "Knowledge": return <><path d="M4 5.5c3-1 5-.5 8 1.5v14c-3-2-5-2.5-8-1.5zM20 5.5c-3-1-5-.5-8 1.5v14c3-2 5-2.5 8-1.5z" /></>;
      case "System": return <><path d="M3 12h4l2-5 4 10 2-5h6" /><path d="M4 4h16v16H4z" /></>;
      case "Settings": return <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>;
      case "Search": return <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></>;
      case "Capture": return <><path d="M12 4v16M4 12h16" /></>;
      case "Collapse": return <><path d="m14 7-5 5 5 5" /><path d="M19 4v16" /></>;
      case "Expand": return <><path d="m10 7 5 5-5 5" /><path d="M5 4v16" /></>;
      case "Menu": return <><path d="M4 7h16M4 12h16M4 17h16" /></>;
    }
  })();
  return <svg className="shell-icon" viewBox="0 0 24 24" aria-hidden="true" {...common}>{shape}</svg>;
}

function readCollapsedPreference() {
  try { return localStorage.getItem(navigationCollapsedKey) === "true"; }
  catch { return false; }
}

export function ApplicationShell({ activeView, pendingReviewCount = 0, status, readOnly = false, contentClassName, onNavigate, onSearch, onCapture, children }: {
  activeView: View;
  pendingReviewCount?: number;
  status: string;
  readOnly?: boolean;
  contentClassName?: string;
  onNavigate: (view: View) => void;
  onSearch: () => void;
  onCapture: () => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [menuOpen, setMenuOpen] = useState(false);
  const layout = useShellLayout(collapsed);
  const narrow = layout.band === "narrow";
  const content = useRef<HTMLElement>(null);
  useEffect(() => { if (!narrow) setMenuOpen(false); }, [narrow]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onSearch();
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        onCapture();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onSearch, onCapture]);
  const setNavigationCollapsed = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(navigationCollapsedKey, String(next)); } catch { /* browser storage unavailable */ }
  };
  // In the narrow band the sheet always shows text labels, whatever the desktop preference.
  const iconOnly = collapsed && !narrow;
  const navigate = (view: View) => { setMenuOpen(false); onNavigate(view); };
  const action = (name: "Search" | "Capture", onClick: () => void) => <button type="button" className="shell-action" aria-label={name} title={iconOnly ? name : undefined} onClick={onClick}>
    {iconOnly && <ShellIcon name={name} />}<span className="shell-label">{name}</span>
  </button>;
  const destination = (item: ShellDestination) => <button type="button" aria-label={item} title={iconOnly ? item : undefined} aria-current={item === activeView ? "page" : undefined} className={item === activeView ? "active" : undefined} onClick={() => navigate(item)}>
    {iconOnly && <ShellIcon name={item} />}<span className="shell-label">{item}</span>
    {item === "Inbox" && pendingReviewCount > 0 ? <> <em title={`${pendingReviewCount} pending`}>{pendingReviewCount}<span className="shell-pending-label"> pending</span></em></> : null}
  </button>;
  const group = (items: readonly ShellDestination[], label: string) => <div className="shell-nav-group" role="list" aria-label={label}>{items.map((item) => <div role="listitem" key={item}>{destination(item)}</div>)}</div>;
  const navigation = <>
    <nav className="nav-main" aria-label="Primary">
      {group(daily, "Daily work")}
      {group(knowledge, "Knowledge and decisions")}
    </nav>
    <div className="shell-sidebar-footer">
      {destination("System")}
      {destination("Settings")}
      <p className="connection" role="status" title={status}><i className={readOnly ? "warning-dot" : ""} /> <span className="shell-label">{status}</span></p>
    </div>
  </>;
  const skipToContent = (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); content.current?.focus(); };

  return <WorkspaceLayoutContext.Provider value={layout}>
    <div className={`application-shell${iconOnly ? " navigation-collapsed" : ""}`} data-band={layout.band} data-height={layout.short ? "short" : "regular"}>
      <a className="skip-link" href="#lifeos-content" onClick={skipToContent}>Skip to content</a>
      {narrow ? <header className="shell-topbar">
        <button type="button" className="shell-topbar-menu" aria-label="Menu" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}><ShellIcon name="Menu" /><span>Menu</span></button>
        <span className="shell-brand" aria-label="LifeOS">LifeOS</span>
        <div className="shell-topbar-actions">
          <button type="button" aria-label="Search" onClick={onSearch}><ShellIcon name="Search" /><span>Search</span></button>
          <button type="button" aria-label="Capture" onClick={onCapture}><ShellIcon name="Capture" /><span>Capture</span></button>
        </div>
      </header> : <aside className="shell-sidebar" aria-label="Application navigation">
        <div className="shell-brand-row">
          <span className="shell-brand" aria-label="LifeOS">{collapsed ? "L" : "LifeOS"}</span>
          <button type="button" className="shell-collapse" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setNavigationCollapsed(!collapsed)}><ShellIcon name={collapsed ? "Expand" : "Collapse"} /></button>
        </div>
        <div className="shell-global-actions">{action("Search", onSearch)}{action("Capture", onCapture)}</div>
        {navigation}
      </aside>}
      <OverlayDialog open={narrow && menuOpen} label="Navigation" variant="sheet" onClose={() => setMenuOpen(false)}>
        <div className="shell-sheet-heading"><span className="shell-brand">LifeOS</span><button type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)}>×</button></div>
        <div className="shell-sidebar shell-sheet">{navigation}</div>
        {/* The band follows the sidebar the user prefers, so a collapsed sidebar can bring a mid-size window back to the compact band. */}
        <button type="button" className="shell-sheet-preference" aria-pressed={collapsed} onClick={() => setNavigationCollapsed(!collapsed)}>{collapsed ? "Use the full sidebar on wider windows" : "Use the collapsed sidebar on wider windows"}</button>
      </OverlayDialog>
      <main id="lifeos-content" ref={content} tabIndex={-1} className={["shell-content", contentClassName].filter(Boolean).join(" ")}>
        <div className="shell-canvas">{children}</div>
      </main>
    </div>
  </WorkspaceLayoutContext.Provider>;
}
