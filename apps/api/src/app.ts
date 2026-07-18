import { randomUUID } from "node:crypto";

import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import { createLogger } from "@raas/logger";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { env } from "./env.js";
import { GLOBAL_BODY_LIMIT_BYTES } from "./lib/body-limits.js";
import { ensureBucketExists } from "./lib/storage.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { documentRoutes } from "./routes/documents.js";
import { healthRoutes } from "./routes/health.js";
import { knowledgeBaseRoutes } from "./routes/knowledge-bases.js";
import { organizationRoutes } from "./routes/organizations.js";
import { usageRoutes } from "./routes/usage.js";
import { v1Routes } from "./routes/v1.js";
import { workspaceRoutes } from "./routes/workspaces.js";

/**
 * Builds (but does not start listening on) a fully wired Fastify instance.
 * Split from index.ts so tests can `buildApp()` and drive it with
 * `app.inject()` without opening a real socket.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const logger = createLogger({ service: "api" });

  const app = Fastify({
    // Cast to Fastify's own logger interface so the instance's Logger type
    // parameter resolves to FastifyBaseLogger (the default every helper in
    // this app is typed against) rather than pino's own, more specific
    // Logger type — the two are runtime-compatible but not structurally
    // assignable to each other, which otherwise breaks every function
    // typed as `(app: FastifyInstance) => ...`.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Opaque, globally-unique request ids — these are echoed back to
    // clients in the { error: { requestId } } envelope, so Fastify's
    // default sequential "req-1" counter (which resets per-process and
    // leaks request volume) isn't good enough.
    genReqId: () => randomUUID(),
    // Fastify's own per-request child logger (request.log) auto-binds the
    // generated id under this label on every log line it produces —
    // renamed from Fastify's default "reqId" to "requestId" to match
    // @raas/logger's LogBindings field name (and the { error: { requestId
    // } } envelope), so a log line and an error response can be
    // correlated on the same field name. requireAuth/requireOrgMembership/
    // requireMembership further bind userId/organizationId onto this same
    // request.log once known (see plugins/auth-guard.ts, lib/membership.ts).
    requestIdLogLabel: "requestId",
    // Rate limiting (lib/rate-limit.ts) keys on request.ip — behind a real
    // reverse proxy/load balancer, that's only correct if Fastify trusts
    // X-Forwarded-For/X-Real-IP rather than resolving to the proxy's own
    // address for every request. Harmless with no proxy in front (falls
    // back to the raw socket address, which is what request.ip already
    // was without this).
    trustProxy: true,
    // Explicit ceiling on every request body (lib/body-limits.ts) —
    // previously Fastify's own undocumented 1 MiB default. Per-route
    // overrides (tighter, for the document metadata routes) are set at
    // those routes directly.
    bodyLimit: GLOBAL_BODY_LIMIT_BYTES,
  });

  await app.register(fastifyCookie);

  // Security headers (docs/decisions.md's production-hardening ticket).
  // apps/api is a JSON-only API — it never serves HTML/CSS/JS to a
  // browser, so helmet's default Content-Security-Policy directives
  // (oriented at HTML-serving apps: 'self' script-src/style-src/etc.)
  // don't protect anything real here. Locking to 'none' is the
  // "appropriate" CSP for a pure API: defense in depth against a
  // response somehow being rendered as HTML, paired with the default
  // X-Content-Type-Options: nosniff (stops a browser from executing a
  // misidentified JSON response as script in the first place). This API
  // is also never legitimately framed, hence X-Frame-Options: DENY
  // rather than helmet's default SAMEORIGIN.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    xFrameOptions: { action: "deny" },
    // apps/web and apps/api are deliberately separate origins (see
    // docs/cors-csrf-policy.md) — helmet's default
    // Cross-Origin-Resource-Policy: same-origin makes browsers refuse to
    // deliver a cross-origin fetch() response to the page that requested
    // it, REGARDLESS of the Access-Control-* headers below. Left at the
    // default here, helmet would silently break every real request
    // apps/web makes to this API. "cross-origin" is required, not just
    // permissive.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // Strict-Transport-Security tells a browser "always use HTTPS for
    // this host from now on" — only true when this deployment is
    // actually terminated over HTTPS (a real production deployment
    // behind a TLS-terminating load balancer/ingress). Gated on
    // NODE_ENV the same way lib/cookies.ts already gates the session
    // cookie's `secure` flag — sending HSTS over local/dev plain HTTP
    // would be actively wrong, not merely unnecessary.
    hsts: env.NODE_ENV === "production" ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  // CORS/CSRF policy: see docs/cors-csrf-policy.md for the full decision.
  // Exactly one allowed origin (WEB_ORIGIN), never a wildcard — this API
  // uses cookie auth, so credentials must be explicitly allowed, and a
  // wildcard origin is incompatible with credentialed requests anyway
  // (browsers reject it). This is one layer of a three-layer CSRF
  // defense alongside SameSite=Lax cookies and the JSON-only content
  // type every mutating route already requires.
  await app.register(fastifyCors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  registerErrorHandler(app);

  // Dev/test convenience (MinIO doesn't pre-provision a bucket the way a
  // real S3/R2 bucket is provisioned out of band) — see storage.ts.
  await ensureBucketExists();

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(organizationRoutes);
  await app.register(workspaceRoutes);
  await app.register(apiKeyRoutes);
  await app.register(knowledgeBaseRoutes);
  await app.register(documentRoutes);
  await app.register(chatRoutes);
  await app.register(conversationRoutes);
  await app.register(usageRoutes);
  await app.register(v1Routes);

  return app;
}
