import type { FastifyInstance } from "fastify";
import type { LifeOSApplication } from "@lifeos/application";

/**
 * PB-030: permanent delete of a deleted note (ADR 0017). The DELETE is a write, so the lease hook answers 423
 * without the lease; a front-matter reference answers 409 with `references` (see `httpError`).
 */
export function registerNotePurge(server: FastifyInstance, application: Pick<LifeOSApplication, "notePurgeCheck" | "purgeNote">) {
  // What the confirmation pop-up lists: blocking references and body links that will show as missing.
  server.get<{ Params: { id: string } }>("/api/v1/notes/:id/purge-check", async (request) => application.notePurgeCheck(request.params.id));
  server.delete<{ Params: { id: string }; Body: { expectedHash?: string } }>("/api/v1/notes/:id/permanent", async (request, reply) => {
    if (typeof request.body?.expectedHash !== "string" || !request.body.expectedHash) return reply.status(400).send({ error: "expectedHash is required to delete a note permanently" });
    return application.purgeNote(request.params.id, request.body.expectedHash);
  });
}
