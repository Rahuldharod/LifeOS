import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { ConnectionsNotice, loadConnections, type ConnectionSettings } from "./connections.js";

const configured: ConnectionSettings = { calendar: { configured: true, connected: true }, drive: { configured: false, connected: false }, keychain: "ok" };

describe("connection status loads on its own (#77)", () => {
  it("never rejects, so a failure cannot fail the rest of a refresh or a settings save", async () => {
    const otherRequests = Promise.resolve(["today", "tasks"]);
    const connections = loadConnections(() => Promise.reject(new ApiError("Keychain access denied", 403)), configured);
    const [others, state] = await Promise.all([otherRequests, connections]);
    expect(others).toEqual(["today", "tasks"]);
    expect(state).toEqual({ settings: configured, keychainDenied: false, error: "Keychain access denied" });
  });

  it("turns a denied Keychain into a typed state on the Connections card", async () => {
    const state = await loadConnections(async () => ({ ...configured, keychain: "denied" }));
    expect(state.keychainDenied).toBe(true);
    const html = renderToStaticMarkup(<ConnectionsNotice state={state} busy={false} onRetry={() => undefined} />);
    expect(html).toContain("Keychain access denied");
    expect(html).toContain(">Retry</button>");
    expect(html).toContain('role="alert"');
  });

  it("shows nothing when status loaded normally", async () => {
    const state = await loadConnections(async () => configured);
    expect(state).toEqual({ settings: configured, keychainDenied: false });
    expect(renderToStaticMarkup(<ConnectionsNotice state={state} busy={false} onRetry={() => undefined} />)).toBe("");
  });

  it("offers Retry when status could not be loaded at all", async () => {
    const state = await loadConnections(() => Promise.reject(new ApiError("LifeOS server is not reachable", 0)));
    expect(renderToStaticMarkup(<ConnectionsNotice state={state} busy={false} onRetry={() => undefined} />)).toContain("Connection status could not be loaded: LifeOS server is not reachable");
  });
});
