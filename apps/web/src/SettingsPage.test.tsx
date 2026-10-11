// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisplayTimeZoneCard, GoogleSecretCard } from "./SettingsPage.js";
import { createSettingsEditorGuard, SettingsWorkspace, type SettingsSection } from "./SettingsWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); });

async function mountCard(content: React.ReactNode) {
  const sections: SettingsSection[] = [
    { id: "card", group: "My LifeOS", label: "Card", cards: [{ id: "real-card", label: "Real card", content }] },
    { id: "other", group: "Connections", label: "Other", cards: [{ id: "other-card", label: "Other", content: <article>Other section</article> }] }
  ];
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<SettingsWorkspace sections={sections} readOnly={false} guard={createSettingsEditorGuard()} />));
}

async function click(name: string) {
  const dialogButton = [...document.querySelectorAll("[role='dialog'] button")].find((item) => item.textContent?.trim() === name);
  const button = (dialogButton ?? [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)) as HTMLButtonElement;
  expect(button, `button ${name}`).toBeTruthy();
  await act(async () => button.click());
}

async function change(label: string, value: string) {
  const input = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement | HTMLSelectElement;
  expect(input, `input ${label}`).toBeTruthy();
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("production Settings cards (#138)", () => {
  it("saves or discards a timezone draft only after the departure choice", async () => {
    const onSave = vi.fn(async () => true);
    await mountCard(<DisplayTimeZoneCard displayTimeZone="Europe/Paris" disabled={false} onSave={onSave} />);
    await change("Display timezone", "Asia/Tokyo");
    expect(onSave).not.toHaveBeenCalled();
    await click("Other"); await click("Stay");
    expect((document.querySelector("[aria-label='Display timezone']") as HTMLSelectElement).value).toBe("Asia/Tokyo");
    await click("Other"); await click("Discard");
    expect(document.body.textContent).toContain("Other section");
    await click("Card");
    expect((document.querySelector("[aria-label='Display timezone']") as HTMLSelectElement).value).toBe("Europe/Paris");
    await change("Display timezone", "Asia/Tokyo"); await click("Other"); await click("Save");
    expect(onSave).toHaveBeenCalledWith("Asia/Tokyo");
  });

  it("keeps a failed timezone choice visible", async () => {
    await mountCard(<DisplayTimeZoneCard displayTimeZone="Europe/Paris" disabled={false} onSave={async () => false} />);
    await change("Display timezone", "Asia/Tokyo"); await click("Other"); await click("Save");
    expect((document.querySelector("[aria-label='Display timezone']") as HTMLSelectElement).value).toBe("Asia/Tokyo");
    expect(document.body.textContent).toContain("Your choice is still here");
  });

  it("does not call the credentials API for a partial guarded draft", async () => {
    const onSave = vi.fn(async () => true);
    await mountCard(<GoogleSecretCard provider="calendar" title="Google Calendar" busy={false} onSave={onSave} />);
    await change("Google Calendar OAuth client ID", "client-id-only");
    await click("Other"); await click("Save");
    expect(onSave).not.toHaveBeenCalled();
    expect((document.querySelector("[aria-label='Google Calendar OAuth client ID']") as HTMLInputElement).value).toBe("client-id-only");
    expect(document.body.textContent).toContain("Enter both the OAuth client ID and client secret");
  });
});
