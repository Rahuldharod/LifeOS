// #121: registers a route from its wire-contract key ("METHOD /path"), so the path is written once and the handler's
// params, query, body and reply are checked against @lifeos/contracts. A handler may still answer an error itself
// (`reply.status(400).send(...)`); only what it returns as its 2xx answer is checked. Types only: nothing is validated.
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import type { BodyOf, Endpoint, ParamsOf, QueryOf, ResponseOf } from "@lifeos/contracts";

export type RouteRequest<E extends Endpoint> = FastifyRequest<{ Params: ParamsOf<E>; Querystring: QueryOf<E>; Body: BodyOf<E> }>;
export type RouteHandler<E extends Endpoint> = (request: RouteRequest<E>, reply: FastifyReply) => Promise<ResponseOf<E> | FastifyReply>;

export function route<E extends Endpoint>(server: FastifyInstance, endpoint: E, handler: RouteHandler<E>) {
  const space = endpoint.indexOf(" ");
  const method = endpoint.slice(0, space) as HTTPMethods;
  const url = endpoint.slice(space + 1);
  server.route({ method, url, handler: handler as (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> });
}
