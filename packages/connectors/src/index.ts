import type { CalendarConnector, CalendarSummary } from "@lifeos/application";
import type { SecretStore } from "@lifeos/application";
import { createHash, randomBytes } from "node:crypto";

export class MockCalendarConnector implements CalendarConnector {
  readonly provider = "mock";
  async listCalendars(): Promise<CalendarSummary[]> {
    return [{ id: "mock-calendar", name: "LifeOS Demo", color: "#5f8b7c" }];
  }
  async listEvents(from: Date, to: Date) {
    const startsAt = new Date(Math.max(from.getTime(), Date.now() + 3_600_000));
    return startsAt < to ? [{
      externalId: "mock-weekly-review",
      title: "Weekly Product Review",
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      timezone: "Europe/Paris",
      calendarId: "mock-calendar",
      calendarName: "LifeOS Demo",
      calendarColor: "#5f8b7c",
      attendees: ["Alex Morgan", "Jamie Chen"],
      clientName: "Example Client",
      productName: "LifeOS",
      projectName: "LifeOS MVP"
    }] : [];
  }
}

type GoogleConnectorOptions = {
  clientId: string;
  redirectUri: string;
  secrets: SecretStore;
  accountKey?: string;
  clientSecretReference?: string;
};

type StoredTokens = { access_token?: string; refresh_token?: string; expires_at?: number };

/**
 * Google rejected the stored credentials (refresh returned invalid_grant, or the API answered 401).
 * Only a new OAuth consent fixes it, so the server maps this to 401 with `reconnect: true` (PB-022a).
 */
export class GoogleAuthError extends Error {
  override readonly name = "GoogleAuthError";
  readonly reconnect = true;
  constructor(message: string, readonly reason: "expired" | "not-connected") { super(message); }
}

export class GoogleCalendarConnector implements CalendarConnector {
  readonly provider = "google";
  private readonly accountKey: string;
  private readonly clientSecretReference: string;
  /** Set when Google rejects the tokens; kept in memory so the stored tokens are never rewritten on failure. */
  private authFailure?: GoogleAuthError;
  constructor(private readonly options: GoogleConnectorOptions) {
    this.accountKey = options.accountKey ?? "default";
    this.clientSecretReference = options.clientSecretReference ?? `google:${this.accountKey}:client-secret`;
  }

  async status(): Promise<{ configured: boolean; connected: boolean; provider: string; reason?: "expired" }> {
    const hasTokens = Boolean(await this.options.secrets.get(this.ref("tokens")));
    if (hasTokens && this.authFailure?.reason === "expired") return { configured: true, connected: false, provider: "google", reason: "expired" };
    return { configured: true, connected: hasTokens, provider: "google" };
  }

  async authorizationUrl() {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await this.options.secrets.set(this.ref("oauth-state"), state);
    await this.options.secrets.set(this.ref("pkce-verifier"), verifier);
    const query = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: "code", scope: "https://www.googleapis.com/auth/calendar.readonly", access_type: "offline", include_granted_scopes: "true", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
  }

  async completeAuthorization(code: string, state: string) {
    const [expectedState, verifier, clientSecret] = await Promise.all([this.options.secrets.get(this.ref("oauth-state")), this.options.secrets.get(this.ref("pkce-verifier")), this.options.secrets.get(this.clientSecretReference)]);
    if (!expectedState || state !== expectedState) throw new Error("Google OAuth state did not match");
    if (!verifier) throw new Error("Google OAuth verifier is missing; restart connection");
    const body = new URLSearchParams({ client_id: this.options.clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: this.options.redirectUri });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== "string") throw new Error(`Google token exchange failed: ${String(payload.error_description ?? payload.error ?? response.status)}`);
    const existing = await this.tokens();
    const tokens: StoredTokens = { access_token: payload.access_token, refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : existing?.refresh_token, expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000 };
    await this.options.secrets.set(this.ref("tokens"), JSON.stringify(tokens));
    this.authFailure = undefined;
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const { calendars } = await this.fetchCalendars();
    return calendars.map((calendar) => ({
      id: String(calendar.id),
      name: String(calendar.summaryOverride ?? calendar.summary ?? calendar.id),
      color: typeof calendar.backgroundColor === "string" ? calendar.backgroundColor : undefined
    }));
  }

  private async fetchCalendars() {
    const accessToken = await this.accessToken();
    const headers = { authorization: `Bearer ${accessToken}` };
    const calendarsResponse = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&showHidden=false", { headers });
    const calendarsPayload = await calendarsResponse.json() as { items?: Array<Record<string, any>>; error?: { message?: string } };
    if (calendarsResponse.status === 401) throw this.failAuth(`Google rejected the Calendar access token: ${calendarsPayload.error?.message ?? 401}`);
    if (!calendarsResponse.ok) throw new Error(`Google Calendar list request failed: ${calendarsPayload.error?.message ?? calendarsResponse.status}`);
    const calendars = (calendarsPayload.items ?? []).filter((calendar) => calendar.id && calendar.hidden !== true && calendar.selected !== false);
    return { headers, calendars };
  }

  async listEvents(from: Date, to: Date) {
    const { headers, calendars } = await this.fetchCalendars();
    const eventGroups = await Promise.all(calendars.map(async (calendar) => {
      const query = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(calendar.id))}/events?${query}`, { headers });
      const payload = await response.json() as { items?: Array<Record<string, any>>; error?: { message?: string } };
      if (!response.ok) throw new Error(`Google Calendar request failed for ${String(calendar.summary ?? calendar.id)}: ${payload.error?.message ?? response.status}`);
      return (payload.items ?? []).filter((event) => event.status !== "cancelled" && event.id && event.start && event.end).map((event) => {
        const allDay = Boolean(event.start.date && !event.start.dateTime);
        const rawStart = String(event.start.dateTime ?? `${event.start.date}T00:00:00.000Z`);
        const rawEnd = String(event.end.dateTime ?? `${event.end.date}T00:00:00.000Z`);
        return {
          externalId: String(event.id),
          calendarId: String(calendar.id),
          calendarName: String(calendar.summaryOverride ?? calendar.summary ?? calendar.id),
          calendarColor: typeof calendar.backgroundColor === "string" ? calendar.backgroundColor : undefined,
          title: String(event.summary ?? "Untitled event"),
          startsAt: new Date(rawStart).toISOString(),
          endsAt: new Date(rawEnd).toISOString(),
          timezone: String(event.start.timeZone ?? event.end.timeZone ?? calendar.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
          isAllDay: allDay,
          attendees: Array.isArray(event.attendees) ? event.attendees.map((attendee: Record<string, unknown>) => String(attendee.displayName ?? attendee.email ?? "Unknown attendee")) : []
        };
      });
    }));
    return eventGroups.flat().sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  }

  private ref(suffix: string) { return `google:${this.accountKey}:${suffix}`; }
  private async tokens(): Promise<StoredTokens | undefined> {
    const raw = await this.options.secrets.get(this.ref("tokens"));
    return raw ? JSON.parse(raw) as StoredTokens : undefined;
  }
  private async accessToken() {
    const tokens = await this.tokens();
    if (tokens?.access_token && (tokens.expires_at ?? 0) > Date.now() + 60_000) return tokens.access_token;
    if (!tokens?.refresh_token) throw new GoogleAuthError("Google Calendar is not connected", "not-connected");
    const clientSecret = await this.options.secrets.get(this.clientSecretReference);
    const body = new URLSearchParams({ client_id: this.options.clientId, refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const payload = await response.json() as Record<string, unknown>;
    // invalid_grant means the refresh token is expired or revoked; retrying cannot succeed.
    if (payload.error === "invalid_grant") throw this.failAuth(`Google Calendar access expired or was revoked (${String(payload.error_description ?? "invalid_grant")}). Reconnect Google Calendar.`);
    if (!response.ok || typeof payload.access_token !== "string") throw new Error(`Google token refresh failed: ${String(payload.error_description ?? payload.error ?? response.status)}`);
    const refreshed = { ...tokens, access_token: payload.access_token, expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000 };
    await this.options.secrets.set(this.ref("tokens"), JSON.stringify(refreshed));
    this.authFailure = undefined;
    return refreshed.access_token;
  }
  private failAuth(message: string) {
    this.authFailure = new GoogleAuthError(message, "expired");
    return this.authFailure;
  }
}
