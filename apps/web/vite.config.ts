import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readAppInfo } from "@lifeos/build-info";

// Dev ports (PB-001): the stable app owns 4310, so the dev UI and API never collide with it.
// #208: the UI's App version is baked in at build time, so the stable app's snapshot shows the version it was built from.
// @lifeos/build-info is TypeScript source, so the package scripts load this config with `--configLoader runner`.
export default defineConfig(({ command }) => {
  const devServer = command === "serve";
  return {
    plugins: [react()],
    define: { __LIFEOS_APP_INFO__: JSON.stringify({ ...readAppInfo({ dev: devServer }), builtAt: new Date().toISOString(), devServer }) },
    server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": "http://127.0.0.1:4311" } }
  };
});
