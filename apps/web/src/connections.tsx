// #77: connection status is loaded on its own, so a Keychain problem only ever affects the Connections card.
import React from "react";

export type ConnectionSettings = {
  calendar: { configured: boolean; connected: boolean; reason?: "expired" };
  drive: { configured: boolean; connected: boolean };
  /** "denied" after the user clicked Deny on a macOS Keychain prompt. */
  keychain?: "ok" | "denied";
};

export type ConnectionsState = { settings?: ConnectionSettings; keychainDenied: boolean; error?: string };

/** Never rejects: a failed request becomes an error on the Connections card, not a failed page refresh or save. */
export async function loadConnections(request: () => Promise<ConnectionSettings>, previous?: ConnectionSettings): Promise<ConnectionsState> {
  try {
    const settings = await request();
    return { settings, keychainDenied: settings.keychain === "denied" };
  } catch (error) {
    return { settings: previous, keychainDenied: false, error: error instanceof Error ? error.message : "Could not load connection status" };
  }
}

/** Shown above the Google cards when the Keychain was denied or status could not be loaded. */
export function ConnectionsNotice({ state, busy, onRetry }: { state?: ConnectionsState; busy: boolean; onRetry: () => void }) {
  if (!state || (!state.keychainDenied && !state.error)) return null;
  const text = state.keychainDenied ? "Keychain access denied. LifeOS cannot tell whether Google credentials are saved until you allow access." : `Connection status could not be loaded: ${state.error}`;
  return <div className="calendar-error" role="alert"><p>{text}</p><button disabled={busy} onClick={onRetry}>Retry</button></div>;
}
