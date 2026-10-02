import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev ports (PB-001): the stable app owns 4310, so the dev UI and API never collide with it.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": "http://127.0.0.1:4311" } }
});
