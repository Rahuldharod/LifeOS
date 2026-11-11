import type { FastifyInstance } from "fastify";
import type { LifeOSApplication } from "@lifeos/application";
import { route } from "./route.js";

/**
 * The Duplicate clean-up (CONTEXT.md): the list writes nothing; applying takes a backup first through `backUp`
 * (the "Back up now" backup), and a backup that fails or does not run changes nothing.
 */
export function registerDuplicateCleanup(server: FastifyInstance, application: Pick<LifeOSApplication, "duplicateCleanup" | "applyDuplicateCleanup">, backUp: () => Promise<{ backupId: string } | undefined>) {
  route(server, "GET /api/v1/people/duplicates", async () => application.duplicateCleanup());
  route(server, "POST /api/v1/people/duplicates/clean-up", async (request, reply) => {
    const body = request.body as { merges?: unknown; repairs?: unknown } | undefined;
    const isId = (value: unknown): value is string => typeof value === "string" && value !== "";
    const merges = Array.isArray(body?.merges) && body.merges.every((pair: { keepPersonId?: unknown; mergePersonId?: unknown } | null) => isId(pair?.keepPersonId) && isId(pair?.mergePersonId)) ? body.merges as Array<{ keepPersonId: string; mergePersonId: string }> : undefined;
    const repairs = Array.isArray(body?.repairs) && body.repairs.every(isId) ? body.repairs as string[] : undefined;
    if (!merges || !repairs) return reply.status(400).send({ error: "merges and repairs must be lists of people" });
    return application.applyDuplicateCleanup({ merges, repairs }, async () => {
      const backup = await backUp();
      if (!backup) throw new Error("The backup did not run, so nothing was changed");
      return backup;
    });
  });
}
