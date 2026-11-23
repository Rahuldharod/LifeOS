import React from "react";

export type InboxPage = "inbox" | "history";

/** The Inbox / History switch in the page header (#243). The layout toggles stay in the Inbox tab row, not here. */
export function InboxSwitch({ page, onPage }: { page: InboxPage; onPage: (page: InboxPage) => void }) {
  return <nav className="inbox-switch" aria-label="Inbox pages">
    {(["inbox", "history"] as const).map((name) => <button key={name} type="button" aria-current={page === name ? "page" : undefined} className={page === name ? "selected" : ""} onClick={() => { if (page !== name) onPage(name); }}>{name === "inbox" ? "Inbox" : "History"}</button>)}
  </nav>;
}
