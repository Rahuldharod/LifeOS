import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, currentServerConnection } from "./api.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("server connection tracking (PB-001)", () => {
  it("goes offline when the server is unreachable and back online, with a reconnect count, once health answers", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetch);
    const before = currentServerConnection().reconnects;

    await expect(api("GET /api/v1/notes")).rejects.toMatchObject({ status: 0 });
    expect(currentServerConnection().online).toBe(false);

    fetch.mockResolvedValue(json(200, { ok: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(currentServerConnection()).toEqual({ online: true, reconnects: before + 1 });
  });

  it("treats a dev-proxy 5xx without a JSON body as offline, but a JSON API error as a normal error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));
    await expect(api("GET /api/v1/notes")).rejects.toMatchObject({ status: 0 });
    expect(currentServerConnection().online).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { error: "conflict" })));
    const error = await api("GET /api/v1/notes").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: "conflict" });
    expect(currentServerConnection().online).toBe(true);
  });
});

describe("calls by wire-contract endpoint (#121)", () => {
  it("fills path parameters, adds the query and sends the method with a JSON body", async () => {
    const fetch = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);

    await api("POST /api/v1/notes/:id/restore", { params: { id: "n 1" }, body: { expectedHash: "h" } });
    await api("GET /api/v1/today/panels", { query: { date: "2026-10-10", timeZone: "Europe/Paris" } });
    await api("GET /api/v1/decisions", { query: new URLSearchParams() });
    await api("GET /api/v1/notes", { query: { state: "open", type: ["meeting-note", "knowledge-note"], q: undefined } });
    await api("POST /api/v1/review-items/:id/reject", { params: { id: "r1" } });

    expect(fetch.mock.calls).toEqual([
      ["/api/v1/notes/n%201/restore", { method: "POST", body: JSON.stringify({ expectedHash: "h" }), headers: { "content-type": "application/json" } }],
      ["/api/v1/today/panels?date=2026-10-10&timeZone=Europe%2FParis", { method: "GET", body: undefined, headers: undefined }],
      ["/api/v1/decisions", { method: "GET", body: undefined, headers: undefined }],
      ["/api/v1/notes?state=open&type=meeting-note&type=knowledge-note", { method: "GET", body: undefined, headers: undefined }],
      ["/api/v1/review-items/r1/reject", { method: "POST", body: undefined, headers: undefined }]
    ]);
  });
});
