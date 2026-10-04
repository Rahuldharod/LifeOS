// Maps thrown errors to HTTP responses. Errors are matched by name so the server needs no adapter classes.
export function httpError(error: unknown): { statusCode: number; body: { error: string; reconnect?: true; reason?: string } } {
  const failure = error instanceof Error ? error : new Error("Unknown server error");
  if (failure.name === "GoogleAuthError") {
    // PB-022a: Google rejected the tokens; the UI must offer Reconnect instead of showing an empty calendar.
    return { statusCode: 401, body: { error: failure.message, reconnect: true, reason: String((failure as { reason?: unknown }).reason ?? "expired") } };
  }
  // #77: the user clicked Deny on a Keychain prompt; the Connections card offers Retry.
  if (failure.name === "KeychainAccessDeniedError") return { statusCode: 403, body: { error: "Keychain access denied", reason: "keychain-denied" } };
  return { statusCode: failure.name === "ObjectConflictError" ? 409 : 400, body: { error: failure.message } };
}
