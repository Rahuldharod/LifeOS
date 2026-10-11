// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsEditorGuard, SettingsWorkspace, useSettingsCardGuard, type SettingsSection } from "./SettingsWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function DraftCard({ fail = false }: { fail?: boolean }) {
  const [saved, setSaved] = useState("Paris"); const [value, setValue] = useState(saved); const [error, setError] = useState("");
  const save = async () => { if (fail) { setError("Could not save timezone"); return false; } setSaved(value); setError(""); return true; };
  useSettingsCardGuard("timezone", { dirty: value !== saved, save, discard: () => { setValue(saved); setError(""); } });
  return <article><h3>Display timezone</h3><input aria-label="Timezone draft" value={value} onChange={(event) => setValue(event.target.value)} /><button onClick={() => void save()}>Save card</button>{error && <p role="alert">{error}</p>}</article>;
}

const sections = (fail = false): SettingsSection[] => [
  { id: "general", group: "My LifeOS", label: "General", cards: [{ id: "timezone", label: "Display timezone", safeStatus: "Europe/Paris", content: <DraftCard fail={fail} /> }, { id: "today", label: "Today", content: <div>Today settings</div> }] },
  { id: "google", group: "Connections", label: "Google", cards: [{ id: "google-calendar", label: "Google Calendar", safeStatus: "Connected", content: <div>Connection card</div> }] },
  { id: "backups", group: "Data & devices", label: "Backups", cards: [{ id: "backup-folder", label: "Off-Drive backup folder", content: <div>Backup card</div> }] },
  { id: "projects", group: "Reference data", label: "Projects", cards: [{ id: "projects-list", label: "Projects", safeNames: ["Autumn launch"], content: <div>Autumn launch</div> }] }
];

async function render(options: { selectedCardId?: string; fail?: boolean; failure?: string; loading?: boolean; readOnly?: boolean; sections?: SettingsSection[] } = {}) {
  const guard = createSettingsEditorGuard();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<SettingsWorkspace sections={options.sections ?? sections(options.fail)} selectedCardId={options.selectedCardId} loading={options.loading} failure={options.failure} readOnly={options.readOnly ?? false} guard={guard} onOpenCard={vi.fn()} />));
  return guard;
}

async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLButtonElement;
  expect(button, `button ${name}`).toBeTruthy(); await act(async () => button.click());
}
async function type(label: string, value: string) {
  const input = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("SettingsWorkspace", () => {
  it("groups the rail and opens initial and deep-linked cards", async () => {
    await render({ selectedCardId: "google-calendar" });
    const rail = document.querySelector("[aria-label='Settings sections']")!;
    expect(rail.textContent).toMatch(/My LifeOS.*Connections.*Data & devices.*Reference data/s);
    expect(document.querySelector("[aria-label='Settings section']")?.textContent).toContain("Connection card");
    await click("General");
    expect(document.querySelector("[aria-label='Settings section']")?.textContent).toContain("Display timezone");
  });

  it("searches safe labels, statuses and reference names, never card input values", async () => {
    await render();
    await type("Search settings", "Connected");
    expect(document.body.textContent).toContain("Google Calendar");
    await type("Search settings", "Autumn launch");
    expect(document.body.textContent).toContain("Projects");
    await type("Search settings", "Paris");
    expect(document.querySelector("[aria-label='Settings search results']")?.textContent).toContain("Display timezone");
    await type("Timezone draft", "private-secret-value");
    await type("Search settings", "private-secret-value");
    expect(document.querySelector("[aria-label='Settings search results']")?.textContent).toContain("No settings found");
  });

  it("guards a section switch with Save, Discard and Stay", async () => {
    await render(); await type("Timezone draft", "Tokyo"); await click("Google");
    expect(document.querySelector("[role='dialog']")?.textContent).toMatch(/Save.*Discard.*Stay/s);
    await click("Stay"); expect(document.body.textContent).toContain("Display timezone");
    await click("Google"); await click("Discard"); expect(document.body.textContent).toContain("Connection card");
    await click("General"); expect((document.querySelector("[aria-label='Timezone draft']") as HTMLInputElement).value).toBe("Paris");
    await type("Timezone draft", "Tokyo"); await click("Google"); await click("Save"); expect(document.body.textContent).toContain("Connection card");
  });

  it("keeps failed-save input and card visible", async () => {
    await render({ fail: true }); await type("Timezone draft", "Tokyo"); await click("Google"); await click("Save");
    expect(document.querySelector("[aria-label='Timezone draft']")).toBeTruthy();
    expect((document.querySelector("[aria-label='Timezone draft']") as HTMLInputElement).value).toBe("Tokyo");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Could not save timezone");
  });

  it("exposes dirty state to in-app navigation", async () => {
    const guard = await render(); expect(guard.dirty).toBe(false); await type("Timezone draft", "Tokyo"); expect(guard.dirty).toBe(true);
    let result: boolean | undefined; await act(async () => { void guard.saveNow().then((value) => { result = value; }); });
    await click("Discard"); expect(result).toBe(true); expect(guard.dirty).toBe(false);
  });

  it("disables guarded Save if the write lease is lost after editing", async () => {
    const guard = await render();
    await type("Timezone draft", "Tokyo"); await click("Google");
    await act(async () => root!.render(<SettingsWorkspace sections={sections()} readOnly guard={guard} onOpenCard={vi.fn()} />));
    const save = [...document.querySelectorAll("[role='dialog'] button")].find((button) => button.textContent === "Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("lost write access");
    await click("Discard");
    expect(document.body.textContent).toContain("Connection card");
  });

  it("uses list then full section with Back on narrow screens and preserves a draft when staying", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    await render(); expect((document.querySelector("[aria-label='Settings section']") as HTMLElement).hidden).toBe(true);
    await click("General"); await type("Timezone draft", "Tokyo"); await click("Back to settings sections");
    await click("Stay");
    expect((document.querySelector("[aria-label='Timezone draft']") as HTMLInputElement).value).toBe("Tokyo");
    await click("Back to settings sections"); await click("Discard");
    expect((document.querySelector("[aria-label='Settings sections']") as HTMLElement).hidden).toBe(false);
    await click("General"); expect((document.querySelector("[aria-label='Timezone draft']") as HTMLInputElement).value).toBe("Paris");
  });

  it("shows loading and read-only states", async () => {
    await render({ loading: true, readOnly: true });
    expect(document.body.textContent).toContain("Loading settings"); expect(document.body.textContent).toContain("Read-only on this Mac");
  });

  it("shows a load failure without exposing card content", async () => {
    await render({ failure: "Settings could not be loaded." });
    expect(document.querySelector("[role='alert']")?.textContent).toBe("Settings could not be loaded.");
    expect(document.querySelector("[aria-label='Timezone draft']")).toBeNull();
  });

  it("shows an empty state when no Settings sections are available", async () => {
    await render({ sections: [] });
    expect(document.querySelector("[aria-label='Settings section']")?.textContent).toContain("Choose a Settings section");
  });
});
