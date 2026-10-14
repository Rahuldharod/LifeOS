// Maps thrown errors to HTTP responses. Errors are matched by name so the server needs no adapter classes.
export function httpError(error: unknown): { statusCode: number; body: { error: string; reconnect?: true; reason?: string; references?: unknown; existingPerson?: { id: string; name: string } } } {
  const failure = error instanceof Error ? error : new Error("Unknown server error");
  // PB-030: a permanent delete refused while other objects reference the note; the UI lists them as links.
  if (failure.name === "NoteReferencedError") return { statusCode: 409, body: { error: failure.message, references: (failure as { references?: unknown }).references ?? [] } };
  // #214: the address is on another person; the UI offers to merge the two.
  if (failure.name === "PersonEmailTakenError") {
    const taken = failure as unknown as { otherPersonId: string; otherPersonName: string };
    return { statusCode: 409, body: { error: failure.message, existingPerson: { id: taken.otherPersonId, name: taken.otherPersonName } } };
  }
  if (failure.name === "GoogleAuthError") {
    // PB-022a: Google rejected the tokens; the UI must offer Reconnect instead of showing an empty calendar.
    return { statusCode: 401, body: { error: failure.message, reconnect: true, reason: String((failure as { reason?: unknown }).reason ?? "expired") } };
  }
  // #77: the user clicked Deny on a Keychain prompt; the Connections card offers Retry.
  if (failure.name === "KeychainAccessDeniedError") return { statusCode: 403, body: { error: "Keychain access denied", reason: "keychain-denied" } };
  // ADR 0022: the request was valid but the feedback file could not be written.
  if (failure.name === "FeedbackWriteError") return { statusCode: 500, body: { error: failure.message } };
  // #180: a Series view cursor this server did not issue (malformed or tampered).
  if (failure.name === "SeriesViewCursorError") return { statusCode: 400, body: { error: failure.message } };
  return { statusCode: failure.name === "ObjectConflictError" ? 409 : 400, body: { error: failure.message } };
}
