// #208: the UI's App version, baked in by the Vite build (see vite.config.ts). Unit tests run without Vite, so they see "unknown".
declare const __LIFEOS_APP_INFO__: { version: string; commit: string; builtAt: string } | undefined;

export const uiAppInfo = typeof __LIFEOS_APP_INFO__ === "undefined" ? { version: "unknown", commit: "unknown", builtAt: "" } : __LIFEOS_APP_INFO__;
