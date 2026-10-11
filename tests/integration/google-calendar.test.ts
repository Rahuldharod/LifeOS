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
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "event-1", summary: "Planning", status: "confirmed", start: { dateTime: "2026-09-22T11:00:00+02:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-09-22T12:00:00+02:00", timeZone: "Europe/Paris" }, attendees: [{ email: "alex@example.com" }, { email: "me@example.com", displayName: "Me", self: true }, { email: "room-4@resource.calendar.google.com", displayName: "Room 4", resource: true }] }, { id: "event-2", summary: "Skipped", status: "confirmed", start: { dateTime: "2026-09-22T15:00:00+02:00" }, end: { dateTime: "2026-09-22T16:00:00+02:00" }, attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }] }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await connector.completeAuthorization("code", authorizationUrl.searchParams.get("state")!);
    expect((await connector.status()).connected).toBe(true);
    const events = await connector.listEvents(new Date("2026-09-22T00:00:00Z"), new Date("2026-09-23T00:00:00Z"));
    expect(events[0]).toMatchObject({ externalId: "event-1", calendarId: "primary", calendarName: "Work", calendarColor: "#4f7cac", title: "Planning", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T10:00:00.000Z", timezone: "Europe/Paris", attendees: ["alex@example.com", "Me", "Room 4"], attendeeDetails: [{ email: "alex@example.com" }, { email: "me@example.com", displayName: "Me", self: true }] });
    // #44: an invitation the user declined is flagged so enrichment skips it.
    expect(events.map((event) => event.declined)).toEqual([false, true]);
    expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])).toContain("singleEvents=true");
    expect(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])).toContain("showDeleted=true");
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

  it("preserves recurring occurrence identity, moves, cancellations and provider series splits", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("google:default:tokens", JSON.stringify({ access_token: "access", expires_at: Date.now() + 3_600_000 }));
    const connector = new GoogleCalendarConnector({ clientId: "client.apps.googleusercontent.com", redirectUri: "http://127.0.0.1/callback", secrets });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "primary", summary: "Work", timeZone: "Europe/Paris" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [
        { id: "instance-normal", recurringEventId: "series-a", iCalUID: "weekly@example.com", status: "confirmed", summary: "Weekly", originalStartTime: { dateTime: "2026-10-05T10:00:00+02:00" }, start: { dateTime: "2026-10-05T10:00:00+02:00" }, end: { dateTime: "2026-10-05T11:00:00+02:00" } },
        { id: "instance-moved", recurringEventId: "series-a", iCalUID: "weekly@example.com", status: "confirmed", summary: "Weekly moved", originalStartTime: { dateTime: "2026-10-12T10:00:00+02:00" }, start: { dateTime: "2026-10-13T14:00:00+02:00" }, end: { dateTime: "2026-10-13T15:00:00+02:00" } },
        { id: "instance-cancelled", recurringEventId: "series-a", iCalUID: "weekly@example.com", status: "cancelled", originalStartTime: { dateTime: "2026-10-19T10:00:00+02:00" } },
        { id: "instance-split", recurringEventId: "series-b", iCalUID: "weekly@example.com", status: "confirmed", summary: "Weekly new time", originalStartTime: { dateTime: "2026-10-26T09:00:00+01:00" }, start: { dateTime: "2026-10-26T09:00:00+01:00" }, end: { dateTime: "2026-10-26T10:00:00+01:00" } },
        { id: "copied-event", iCalUID: "same-series-looking@example.com", status: "confirmed", summary: "Copied", start: { dateTime: "2026-10-27T09:00:00+01:00" }, end: { dateTime: "2026-10-27T10:00:00+01:00" } }
      ] }), { status: 200 }));

    const events = await connector.listEvents(new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));

    expect(events.find((event) => event.externalId === "instance-normal")).toMatchObject({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z", status: "confirmed" });
    expect(events.find((event) => event.externalId === "instance-moved")).toMatchObject({ startsAt: "2026-10-13T12:00:00.000Z", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    expect(events.find((event) => event.externalId === "instance-cancelled")).toMatchObject({ seriesId: "series-a", status: "cancelled", originalOccurrenceStartsAt: "2026-10-19T08:00:00.000Z" });
    expect(events.find((event) => event.externalId === "instance-split")).toMatchObject({ seriesId: "series-b", previousSeriesId: "series-a" });
    expect(events.find((event) => event.externalId === "copied-event")).not.toHaveProperty("seriesId");
  });
});
