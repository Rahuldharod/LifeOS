// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupVerification, ConnectionSettings, SystemHealth } from "@lifeos/contracts";
import { AppStatusBanners, connectionDeviceSettingsSections } from "./ConnectionDeviceSettings.js";
import { createSettingsEditorGuard, SettingsWorkspace } from "./SettingsWorkspace.js";

vi.mock("./api.js", () => ({
  api: vi.fn(async (key: string) => key === "GET /api/v1/settings/backups" ? { offDriveFolder: "", contentHash: "backup-settings" } : undefined),
  ApiError: class ApiError extends Error { status = 500; }
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); });

const connected: ConnectionSettings = {
  calendar: { configured: true, connected: true, lastSuccessfulSyncAt: "2026-10-11T08:00:00.000Z" },
  drive: { configured: true, connected: false },
  keychain: "ok"
};
const health: SystemHealth = {
  status: "healthy", objectCount: 12, diagnostics: [], appInfo: { version: "26.10.14.1", commit: "abc1234" },
  session: { currentDeviceId: "desk-mac", activeDeviceId: "desk-mac", startedAt: "2026-10-11T07:00:00.000Z", lastActivityAt: "2026-10-11T08:00:00.000Z", leaseExpiresAt: "2026-10-11T08:15:00.000Z", writeAllowed: true }
};
const verification: BackupVerification = { backupId: "backup-1", createdAt: "2026-10-11T08:10:00.000Z", fileCount: 21, totalBytes: 4096, valid: true, restoredToTemporaryDirectory: true, diagnostics: [] };

const props = () => ({
  calendarCatalog: [{ id: "work", name: "Work", color: "#123456" }], calendarCatalogLoaded: true,
  calendarPrefs: { disabledCalendarIds: [] }, connections: { settings: connected, keychainDenied: false },
  health, backups: [verification], lastVerification: verification, busy: false, readOnly: false,
  displayTimeZone: "Europe/Paris",
  onRetryConnections: vi.fn(async () => undefined), onSaveGoogleSecrets: vi.fn(async () => true),
  onSaveCalendarPrefs: vi.fn(async () => undefined), onCreateAndVerifyBackup: vi.fn(async () => verification),
  onVerifyBackup: vi.fn(async () => verification), onTakeOverSession: vi.fn(async () => undefined)
});

async function renderSection(cardId: string, changes: Partial<ReturnType<typeof props>> = {}) {
  const value = { ...props(), ...changes };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<SettingsWorkspace sections={connectionDeviceSettingsSections(value)} selectedCardId={cardId} readOnly={value.readOnly} guard={createSettingsEditorGuard()} />));
  return value;
}

async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name) as HTMLButtonElement;
  expect(button, `button ${name}`).toBeTruthy();
  await act(async () => button.click());
}

describe("Connections and Data & devices Settings (#139)", () => {
  it("shows connected and disconnected Google status without ever rendering saved secret values", async () => {
    await renderSection("settings-google-calendar");
    expect(document.body.textContent).toMatch(/Google Calendar.*Credentials configured.*Connected/s);
    expect(document.body.textContent).toMatch(/Google Drive.*Credentials configured.*Stored for the upcoming Drive source connector/s);
    expect((document.querySelector("[aria-label='Google Calendar OAuth client secret']") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("saved-secret-value");

    await act(async () => root!.render(<SettingsWorkspace sections={connectionDeviceSettingsSections({ ...props(), connections: { settings: { calendar: { configured: false, connected: false }, drive: { configured: false, connected: false } }, keychainDenied: false } })} selectedCardId="settings-google-calendar" readOnly={false} guard={createSettingsEditorGuard()} />));
    expect(document.body.textContent).toContain("Credentials required");
  });

  it("keeps loading and connection errors beside the affected controls and allows Retry", async () => {
    await renderSection("settings-google-calendar", { connections: undefined });
    expect(document.querySelector("[aria-busy='true']")?.textContent).toContain("Loading connection status");
    const retry = vi.fn(async () => undefined);
    await act(async () => root!.render(<SettingsWorkspace sections={connectionDeviceSettingsSections({ ...props(), connections: { settings: connected, keychainDenied: false, error: "LifeOS server is not reachable" }, onRetryConnections: retry })} selectedCardId="settings-google-calendar" readOnly={false} guard={createSettingsEditorGuard()} />));
    expect(document.querySelector("[role='alert']")?.textContent).toContain("LifeOS server is not reachable");
    await click("Retry");
    expect(retry).toHaveBeenCalledOnce();
  });

  it("disables credential, calendar and backup API actions when read-only", async () => {
    const value = await renderSection("settings-google-calendar", { readOnly: true });
    expect((document.querySelector("[aria-label='Google Calendar OAuth client ID']") as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);
    expect(([...document.querySelectorAll("button")].find((item) => item.textContent === "Replace credentials") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => root!.render(<SettingsWorkspace sections={connectionDeviceSettingsSections(value)} selectedCardId="settings-backup-snapshots" readOnly guard={createSettingsEditorGuard()} />));
    const create = [...document.querySelectorAll("button")].find((item) => item.textContent === "Create & verify snapshot") as HTMLButtonElement;
    const verify = [...document.querySelectorAll("button")].find((item) => item.textContent === "Test restore") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(verify.disabled).toBe(true);
    await act(async () => verify.click());
    expect(value.onVerifyBackup).not.toHaveBeenCalled();
  });

  it("formats backup creation instants in the selected display timezone", async () => {
    const nearMidnight = { ...verification, backupId: "backup-midnight", createdAt: "2026-10-11T00:30:00.000Z" };
    await renderSection("settings-backup-snapshots", { backups: [nearMidnight], lastVerification: nearMidnight, displayTimeZone: "America/Los_Angeles" });
    expect(document.querySelector("[aria-label='Created 2026-10-10']")).toBeTruthy();
  });

  it("keeps backup failures local and preserves guarded create-and-verify behavior", async () => {
    const create = vi.fn(async () => { throw new Error("Backup disk unavailable"); });
    await renderSection("settings-backup-snapshots", { onCreateAndVerifyBackup: create });
    await click("Create & verify snapshot");
    expect(create).toHaveBeenCalledOnce();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Backup disk unavailable");
  });

  it("shows system health, safe handoff and explicit loading/error states under Data & devices", async () => {
    await renderSection("settings-system-health");
    expect(document.body.textContent).toMatch(/System health.*12 indexed objects.*SAFE HANDOFF/s);
    await act(async () => root!.render(<SettingsWorkspace sections={connectionDeviceSettingsSections({ ...props(), health: undefined, systemLoading: true })} selectedCardId="settings-system-health" readOnly={false} guard={createSettingsEditorGuard()} />));
    expect(document.querySelector("[aria-busy='true']")?.textContent).toContain("Loading system health");
    await act(async () => root!.render(<SettingsWorkspace sections={connectionDeviceSettingsSections({ ...props(), health: undefined, systemError: "Health check failed" })} selectedCardId="settings-system-health" readOnly={false} guard={createSettingsEditorGuard()} />));
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Health check failed");
  });

  it("renders app-wide read-only and offline banners with guarded actions", async () => {
    const takeOver = vi.fn(async () => undefined); const retry = vi.fn(async () => undefined);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<AppStatusBanners session={{ ...health.session, activeDeviceId: "laptop", writeAllowed: false }} offline={{ reason: "network", error: "No route" }} busy={false} timeZone="Europe/Paris" onTakeOver={takeOver} onRetryCalendar={retry} />));
    expect(document.body.textContent).toMatch(/LifeOS is in use on laptop.*Offline: showing meetings already in LifeOS/s);
    await click("Use LifeOS here"); await click("Retry");
    expect(takeOver).toHaveBeenCalledOnce(); expect(retry).toHaveBeenCalledOnce();
  });
});
