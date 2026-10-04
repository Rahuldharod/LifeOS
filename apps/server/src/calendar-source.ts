// #94: which calendar answers the calendar endpoints. The mock calendar answers only in explicit dev/mock mode;
// otherwise a Keychain denied at startup or on Retry makes every read fail as `KeychainAccessDeniedError`, so the
// calendar day falls back to the stored meetings with the offline banner (#88) instead of showing demo meetings.
import type { CalendarConnector } from "@lifeos/application";
import { KeychainAccessDeniedError, type KnownSecrets } from "@lifeos/secrets";
import { probeConnectionSecrets } from "./connections.js";

export interface CalendarSourceOptions<Google extends CalendarConnector> {
  secrets: KnownSecrets;
  /** `LIFEOS_CALENDAR=mock` (dev mode, PB-001): always the mock calendar, and no secret is read. */
  mockOnly: boolean;
  mock: CalendarConnector;
  createGoogle: (clientId: string) => Google;
}

export function calendarSource<Google extends CalendarConnector>({ secrets, mockOnly, mock, createGoogle }: CalendarSourceOptions<Google>) {
  let google: Google | undefined;
  /** No Google client: unreadable (denied Keychain) is an error; not configured is an empty calendar, never demo data. */
  const current = (): CalendarConnector => {
    if (mockOnly) return mock;
    if (google) return google;
    if (secrets.keychainDenied) throw new KeychainAccessDeniedError();
    return notConfigured;
  };
  const calendar: CalendarConnector = {
    get provider() { return mockOnly ? mock.provider : google?.provider ?? (secrets.keychainDenied ? "google" : "none"); },
    listEvents: async (from, to) => current().listEvents(from, to),
    listCalendars: async () => { const connector = current(); return connector.listCalendars ? connector.listCalendars() : []; }
  };
  return {
    calendar,
    get google() { return google; },
    /** Uses a newly saved client ID. */
    useGoogle(clientId: string) { google = createGoogle(clientId); return google; },
    /** Startup and Retry: the only reads made just to know what is configured (#77). Skipped in mock mode. */
    async probe() {
      if (mockOnly) return;
      const clientId = await probeConnectionSecrets(secrets);
      if (clientId && !google) google = createGoogle(clientId);
    }
  };
}

const notConfigured: CalendarConnector = { provider: "none", listEvents: async () => [], listCalendars: async () => [] };
