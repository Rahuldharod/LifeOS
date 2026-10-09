import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWebApp } from "../../apps/server/src/web-app.js";

// PB-027: every app URL must reload on the stable runtime, so the server answers it with index.html.
describe("web app deep links (PB-027)", () => {
  let webRoot: string;
  const server = () => { const instance = Fastify(); registerWebApp(instance, webRoot); return instance; };

  beforeEach(async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), "lifeos-web-"));
    await mkdir(path.join(webRoot, "assets"));
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><div id=root></div>");
    await writeFile(path.join(webRoot, "assets", "index-abc.js"), "console.log(1)");
  });
  afterEach(async () => { await rm(webRoot, { recursive: true, force: true }); });

  it("serves index.html for every tab and open-item path", async () => {
    const app = server();
    for (const url of ["/", "/today", "/notes/0f8fad5b-d9cb-469f-a165-70867728950e", "/notes/deleted/0f8fad5b-d9cb-469f-a165-70867728950e", "/calendar/2026-10-09/7c9e6679-7425-40de-944b-e07fc1f90ae7", "/open-points", "/inbox/886313e1-3b8a-4372-9b90-0c9aee199e5d"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"], url).toContain("text/html");
      expect(response.headers["cache-control"], url).toBe("no-cache");
      expect(response.body, url).toContain("id=root");
    }
  });

  it("still serves real files, and never answers an unknown API path or a missing asset with the page", async () => {
    const app = server();
    expect((await app.inject({ url: "/assets/index-abc.js" })).body).toBe("console.log(1)");
    expect((await app.inject({ url: "/api/v1/nowhere" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/assets/missing.js" })).statusCode).toBe(404);
  });
});
