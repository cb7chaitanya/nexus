import { recordHttpRequest, registry } from "@raas/metrics";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** hrtime.bigint() captured in onRequest — read back in onResponse to
     * compute request duration without depending on any Fastify-internal
     * timing API (those vary across major versions; this is just Node). */
    metricsStartAt?: bigint;
  }
}

/**
 * The matched route PATTERN (e.g. "/kb/:id/documents"), never the raw
 * request.url — see @raas/metrics's HttpRequestObservation doc comment
 * for why the raw URL (real ids embedded in it) would be an unbounded-
 * cardinality label. Falls back to a fixed placeholder when nothing
 * matched (a 404) — Fastify's routing runs before onRequest hooks fire,
 * so routeOptions is already populated by the time these hooks run for a
 * request that DID match; a request that matched nothing never gets a
 * route context at all.
 */
function routeLabel(request: FastifyRequest): string {
  return request.routeOptions?.url ?? "unmatched_route";
}

/**
 * Wires up this app's whole observability-on-every-request surface in one
 * place: request-count/latency/error metrics (@raas/metrics) AND the
 * method/route fields every request logger should carry (this ticket's
 * logging requirement) — both derive from the same "what route did this
 * request match" resolution, so one hook pair does both rather than two
 * hooks duplicating that resolution. Registered early in app.ts, before
 * any route-specific preHandler, so requestId/method/route are on
 * request.log for every log line a route or its preHandlers produce —
 * userId (requireAuth) and organizationId (requireMembership) are added
 * on top of this by their own existing .child() calls, unchanged.
 *
 * GET /metrics is a plain route on this same instance, so it goes through
 * these same global hooks and does get counted like any other request —
 * deliberately not special-cased out. A scrape every 15-30s is a fixed,
 * tiny, honest cost, not a runaway feedback loop (each scrape increments
 * its own counter by exactly one, once, synchronously — there's no
 * recursion), and "is /metrics itself being scraped" is real operational
 * signal worth keeping rather than hiding.
 */
export function registerMetrics(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
    request.metricsStartAt = process.hrtime.bigint();
    request.log = request.log.child({ method: request.method, route: routeLabel(request) });
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const durationSeconds = request.metricsStartAt ? Number(process.hrtime.bigint() - request.metricsStartAt) / 1e9 : 0;
    recordHttpRequest({
      method: request.method,
      route: routeLabel(request),
      statusCode: reply.statusCode,
      durationSeconds,
    });
  });

  // No auth, no rate limit — same trust model as GET /health (see
  // routes/health.ts): a Prometheus scraper carries no session/API key.
  // This exposes operational metrics (request rates, error rates, queue
  // throughput), not tenant data, but should still not be reachable from
  // the public internet in a real deployment — see DEPLOYMENT.md.
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    reply.send(await registry.metrics());
  });
}
