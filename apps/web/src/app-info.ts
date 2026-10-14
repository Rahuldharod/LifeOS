// #208: the UI's App version, baked in by the Vite build (see vite.config.ts). Unit tests run without Vite, so they see "unknown".
import type { AppInfo } from "@lifeos/contracts";

/** `devServer`: served by `pnpm dev`, where a restart (not `update-app`) brings the UI and server back in line. */
export type UiAppInfo = AppInfo & { builtAt: string; devServer: boolean };

declare const __LIFEOS_APP_INFO__: UiAppInfo | undefined;

export const uiAppInfo: UiAppInfo = typeof __LIFEOS_APP_INFO__ === "undefined" ? { version: "unknown", commit: "unknown", builtAt: "", devServer: false } : __LIFEOS_APP_INFO__;
