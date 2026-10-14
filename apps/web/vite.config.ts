import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readAppInfo } from "../server/src/app-info.js";

// Dev ports (PB-001): the stable app owns 4310, so the dev UI and API never collide with it.
// #208: the UI's App version is baked in at build time, so the stable app's snapshot shows the version it was built from.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: { __LIFEOS_APP_INFO__: JSON.stringify({ ...readAppInfo(undefined, { dev: command === "serve" }), builtAt: new Date().toISOString() }) },
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": "http://127.0.0.1:4311" } }
}));
