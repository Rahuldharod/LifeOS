import path from "node:path";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

const webMimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json" };

/**
 * Serves the production web build (PB-001). Unknown non-API paths without a file extension fall back
 * to index.html, so every app URL (PB-027: `/notes/<id>`, `/calendar/<day>/<id>`…) reloads and bookmarks.
 */
export function registerWebApp(server: FastifyInstance, webRootDirectory: string) {
  const webRoot = path.join(path.resolve(webRootDirectory), path.sep);
  server.get("/*", async (request, reply) => {
    let requested: string;
    try { requested = decodeURIComponent(request.url.split("?")[0]!.replace(/^\//, "")) || "index.html"; }
    catch { return reply.status(404).send({ error: "Not found" }); }
    if (requested.startsWith("api/")) return reply.status(404).send({ error: "Not found" });
    const target = path.resolve(webRoot, requested);
    if (!target.startsWith(webRoot)) return reply.status(404).send({ error: "Not found" });
    let served = target;
    let content = await readFile(target).catch(() => undefined);
    if (!content && !path.extname(requested)) { served = path.join(webRoot, "index.html"); content = await readFile(served).catch(() => undefined); }
    if (!content) return reply.status(404).send({ error: requested === "index.html" ? "Web build not found; run pnpm build" : "Not found" });
    // Vite fingerprints files under assets/, so they can be cached; index.html must always be fresh.
    reply.header("cache-control", served.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.type(webMimeTypes[path.extname(served).toLowerCase()] ?? "application/octet-stream").send(content);
  });
}
