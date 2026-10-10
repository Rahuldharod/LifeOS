import type { FastifyInstance } from "fastify";
import { route } from "./route.js";
import type { LifeOSApplication } from "@lifeos/application";

/**
 * PB-025 and #105: the Notes list with keyword search and filters. `type` repeats for multi-select
 * (`?type=meeting-note&type=knowledge-note`). A bad type or date throws in the use case; `httpError` answers 400.
 */
export function registerNotesList(server: FastifyInstance, application: Pick<LifeOSApplication, "searchNotes">) {
  route(server, "GET /api/v1/notes", async (request, reply) => {
    const { q, state = "open", type, ...filters } = request.query;
    if (state !== "open" && state !== "deleted") return reply.status(400).send({ error: "state must be open or deleted" });
    return application.searchNotes(q ?? "", state, { ...filters, types: type === undefined ? undefined : [type].flat() });
  });
}
