// Connection status without Keychain prompts (#77). Each secret read can show a macOS Keychain prompt, so status
// is answered from what `KnownSecrets` has already seen: the startup probe, a Retry, and every later read or write.
import { isKeychainAccessDenied, type KnownSecrets } from "@lifeos/secrets";

export const secretRefs = {
  calendarClientId: "google:default:client-id",
  calendarClientSecret: "google:default:client-secret",
  calendarTokens: "google:default:tokens",
  driveClientId: "google-drive:default:client-id",
  driveClientSecret: "google-drive:default:client-secret"
} as const;

type KeychainState = "ok" | "denied";
type CalendarAuth = { authExpired: boolean };

/**
 * Reads the few secrets whose presence status needs: at startup and when the user clicks Retry, never per request.
 * Client secrets are not read here; only connecting or syncing needs them. A denied prompt is not an error: status
 * then shows `keychain: "denied"`. Returns the saved calendar client ID, if any.
 */
export async function probeConnectionSecrets(secrets: KnownSecrets) {
  let clientId: string | undefined;
  try {
    clientId = await secrets.get(secretRefs.calendarClientId);
    if (clientId) await secrets.get(secretRefs.calendarTokens);
    await secrets.get(secretRefs.driveClientId);
  } catch (error) {
    if (!isKeychainAccessDenied(error)) throw error;
  }
  return clientId;
}

// Saved together from Settings, so a client secret not yet seen is assumed present beside a known client ID.
const configured = (secrets: KnownSecrets, clientId: string, clientSecret: string) => secrets.has(clientId) === true && secrets.has(clientSecret) !== false;

function calendarConnection(secrets: KnownSecrets, google: CalendarAuth | undefined) {
  const hasTokens = Boolean(google) && secrets.has(secretRefs.calendarTokens) === true;
  return hasTokens && google!.authExpired ? { connected: false, reason: "expired" as const } : { connected: hasTokens };
}

const keychain = (secrets: KnownSecrets): KeychainState => secrets.keychainDenied ? "denied" : "ok";

/** `GET /api/v1/settings/connections`: reads no secret value. */
export function connectionSettings<Sync extends object>(secrets: KnownSecrets, google: CalendarAuth | undefined, sync: Sync) {
  return {
    calendar: { ...calendarConnection(secrets, google), configured: configured(secrets, secretRefs.calendarClientId, secretRefs.calendarClientSecret), ...sync },
    drive: { configured: configured(secrets, secretRefs.driveClientId, secretRefs.driveClientSecret), connected: false },
    keychain: keychain(secrets)
  };
}

/** `GET /api/v1/connections/google`: reads no secret value. */
export function googleConnectionStatus<Sync extends object>(secrets: KnownSecrets, google: CalendarAuth | undefined, sync: Sync) {
  if (!google) return { configured: false, connected: false, provider: "mock", missing: ["Google OAuth Desktop client credentials"], keychain: keychain(secrets) };
  return { configured: true, ...calendarConnection(secrets, google), provider: "google", ...sync, keychain: keychain(secrets) };
}
