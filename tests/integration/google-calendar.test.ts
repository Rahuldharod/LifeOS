import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarConnector } from "@lifeos/connectors";
import { MemorySecretStore } from "@lifeos/secrets";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("Google Calendar connector", () => {
  it("uses state, PKCE, Keychain-compatible secret storage and maps Calendar events", async () => {
    const secrets = new MemorySecretStore();
    const connector = new GoogleCalendarConnector({ clientId: "client.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:4310/api/v1/connections/google/callback", secrets });
    const authorizationUrl = new URL(await connector.authorizationUrl());
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "primary", summary: "Work", selected: true, backgroundColor: "#4f7cac" }, { id: "hidden@example.com", summary: "Hidden", selected: false }] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "event-1", summary: "Planning", status: "confirmed", start: { dateTime: "2026-09-22T11:00:00+02:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-09-22T12:00:00+02:00", timeZone: "Europe/Paris" }, attendees: [{ email: "alex@example.com" }, { email: "me@eagleeye.com", displayName: "Me", self: true }, { email: "room-4@resource.calendar.google.com", displayName: "Room 4", resource: true }] }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await connector.completeAuthorization("code", authorizationUrl.searchParams.get("state")!);
    expect((await connector.status()).connected).toBe(true);
    const events = await connector.listEvents(new Date("2026-09-22T00:00:00Z"), new Date("2026-09-23T00:00:00Z"));
    expect(events[0]).toMatchObject({ externalId: "event-1", calendarId: "primary", calendarName: "Work", calendarColor: "#4f7cac", title: "Planning", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T10:00:00.000Z", timezone: "Europe/Paris", attendees: ["alex@example.com", "Me", "Room 4"], attendeeDetails: [{ email: "alex@example.com" }, { email: "me@eagleeye.com", displayName: "Me", self: true }] });
    expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])).toContain("singleEvents=true");
    expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])).toContain("calendars/primary/events");
  });

  it("lists every visible calendar, even with no events, and skips hidden ones", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("google:default:tokens", JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 }));
    const connector = new GoogleCalendarConnector({ clientId: "client.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:4310/api/v1/connections/google/callback", secrets });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [
      { id: "primary", summary: "Work", backgroundColor: "#4f7cac" },
      { id: "family@example.com", summary: "Family", summaryOverride: "Home" },
      { id: "hidden@example.com", summary: "Hidden", selected: false }
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await connector.listCalendars()).toEqual([
      { id: "primary", name: "Work", color: "#4f7cac" },
      { id: "family@example.com", name: "Home", color: undefined }
    ]);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
