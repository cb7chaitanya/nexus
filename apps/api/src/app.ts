import { randomUUID } from "node:crypto";

import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { createLogger } from "@raas/logger";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { env } from "./env.js";
import { ensureBucketExists } from "./lib/storage.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { documentRoutes } from "./routes/documents.js";
import { knowledgeBaseRoutes } from "./routes/knowledge-bases.js";
import { organizationRoutes } from "./routes/organizations.js";
import { usageRoutes } from "./routes/usage.js";

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
    // Rate limiting (lib/rate-limit.ts) keys on request.ip — behind a real
    // reverse proxy/load balancer, that's only correct if Fastify trusts
    // X-Forwarded-For/X-Real-IP rather than resolving to the proxy's own
    // address for every request. Harmless with no proxy in front (falls
    // back to the raw socket address, which is what request.ip already
    // was without this).
    trustProxy: true,
  });

  await app.register(fastifyCookie);

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

  await app.register(authRoutes);
  await app.register(organizationRoutes);
  await app.register(knowledgeBaseRoutes);
  await app.register(documentRoutes);
  await app.register(chatRoutes);
  await app.register(conversationRoutes);
  await app.register(usageRoutes);

  return app;
}
