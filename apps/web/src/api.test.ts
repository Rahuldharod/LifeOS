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

    await expect(api("/api/v1/notes")).rejects.toMatchObject({ status: 0 });
    expect(currentServerConnection().online).toBe(false);

    fetch.mockResolvedValue(json(200, { ok: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(currentServerConnection()).toEqual({ online: true, reconnects: before + 1 });
  });

  it("treats a dev-proxy 5xx without a JSON body as offline, but a JSON API error as a normal error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));
    await expect(api("/api/v1/notes")).rejects.toMatchObject({ status: 0 });
    expect(currentServerConnection().online).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { error: "conflict" })));
    const error = await api("/api/v1/notes").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: "conflict" });
    expect(currentServerConnection().online).toBe(true);
  });
});
