import type { FastifyInstance } from "fastify";
import type { LifeOSApplication } from "@lifeos/application";

type NotesQuery = { q?: string; state?: string; type?: string | string[]; projectId?: string; clientId?: string; productId?: string; personId?: string; from?: string; to?: string };

/**
 * PB-025 and #105: the Notes list with keyword search and filters. `type` repeats for multi-select
 * (`?type=meeting-note&type=knowledge-note`). A bad type or date throws in the use case; `httpError` answers 400.
 */
export function registerNotesList(server: FastifyInstance, application: Pick<LifeOSApplication, "searchNotes">) {
  server.get<{ Querystring: NotesQuery }>("/api/v1/notes", async (request, reply) => {
    const { q, state = "open", type, ...filters } = request.query;
    if (state !== "open" && state !== "deleted") return reply.status(400).send({ error: "state must be open or deleted" });
    return application.searchNotes(q ?? "", state, { ...filters, types: type === undefined ? undefined : [type].flat() });
  });
}
