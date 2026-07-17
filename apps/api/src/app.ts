import { randomUUID } from "node:crypto";

import fastifyCookie from "@fastify/cookie";
import { createLogger } from "@raas/logger";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import { ensureBucketExists } from "./lib/storage.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { documentRoutes } from "./routes/documents.js";
import { knowledgeBaseRoutes } from "./routes/knowledge-bases.js";
import { organizationRoutes } from "./routes/organizations.js";

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
  });

  await app.register(fastifyCookie);

  registerErrorHandler(app);

  // Dev/test convenience (MinIO doesn't pre-provision a bucket the way a
  // real S3/R2 bucket is provisioned out of band) — see storage.ts.
  await ensureBucketExists();

  await app.register(authRoutes);
  await app.register(organizationRoutes);
  await app.register(knowledgeBaseRoutes);
  await app.register(documentRoutes);
  await app.register(chatRoutes);

  return app;
}
