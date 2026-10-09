/**
 * #95: the clean-stop sequence. The stop backup must see settled data, so writes stop first, then HTTP requests in
 * flight and the adoption queue finish, then the backup runs, and only then is the device lease released.
 * A step that fails or hangs is logged and the sequence carries on, so the lease is always released.
 * The bounded waits plus the stop backup's own timeout stay below the kill timeout in `scripts/lifeos.mjs`.
 */
export interface ShutdownSteps {
  /** From now on HTTP writes answer 503. */
  stopWrites(): void;
  /** Timers and file watchers that start new work. */
  stopTriggers(): void;
  /** Stops listening and waits for requests in flight. */
  closeHttp(): Promise<void>;
  /** Waits for adoption and any other running operation to go idle. */
  waitForIdle(): Promise<void>;
  /** The stop backup; bounded by its own timeout (`stopBackupTimeoutMs`). */
  stopBackup(): Promise<void>;
  /** Releases the device lease. */
  closeSession(): Promise<void>;
  log(error: unknown, step: string): void;
}

export const shutdownLimits = { httpMs: 5_000, idleMs: 10_000 };

export async function shutDown(steps: ShutdownSteps, limits: typeof shutdownLimits = shutdownLimits) {
  const run = async (name: string, work: () => unknown, limitMs?: number) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const done = Promise.resolve().then(work);
      await (limitMs === undefined ? done : Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Stop step "${name}" did not finish within ${limitMs / 1000} s`)), limitMs);
        timer.unref?.();
      })]));
    } catch (error) {
      steps.log(error, name);
    } finally {
      clearTimeout(timer);
    }
  };
  await run("writes", () => steps.stopWrites());
  await run("triggers", () => steps.stopTriggers());
  await run("http", () => steps.closeHttp(), limits.httpMs);
  await run("idle", () => steps.waitForIdle(), limits.idleMs);
  await run("backup", () => steps.stopBackup());
  await run("session", () => steps.closeSession());
}
