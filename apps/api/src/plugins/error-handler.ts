import { ApiError } from "@raas/shared";
import type { FastifyError, FastifyInstance } from "fastify";

/**
 * The single place that translates a thrown error into the wire response.
 * Route handlers throw ApiError (or let an unexpected error propagate)
 * and never format a response body themselves — this is what keeps the
 * { error: { code, message, requestId } } envelope consistent across
 * every route without every handler having to remember the shape.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((err, request, reply) => {
    const requestId = request.id;

    if (err instanceof ApiError) {
      request.log.warn({ err, code: err.code }, err.message);
      reply.status(err.statusCode).send(err.toResponseBody(requestId));
      return;
    }

    // Fastify/framework-level errors (malformed JSON body, payload too
    // large, etc.) — these have a statusCode already and are the client's
    // fault, not ours, but didn't come through ApiError since they're
    // thrown by Fastify itself before a route handler runs.
    const maybeStatusCode = (err as { statusCode?: number }).statusCode;
    if (maybeStatusCode && maybeStatusCode >= 400 && maybeStatusCode < 500) {
      const apiErr = ApiError.badRequest(err.message || "Bad request");
      reply.status(maybeStatusCode).send(apiErr.toResponseBody(requestId));
      return;
    }

    request.log.error({ err }, "unhandled error");
    const apiErr = ApiError.internal();
    reply.status(500).send(apiErr.toResponseBody(requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    const apiErr = ApiError.notFound(`Route not found: ${request.method} ${request.url}`);
    reply.status(apiErr.statusCode).send(apiErr.toResponseBody(request.id));
  });
}
