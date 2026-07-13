import { createLogger } from "@raas/logger";
import Fastify from "fastify";

// Foundation layer only: the process boots, listens, and logs. No routes
// are registered here on purpose — see docs/implementation-plan.md
// ("Do NOT add: routes"). Auth, tenant-scoped queries, and business
// endpoints are later tickets (RAAS-9 onward).

const logger = createLogger({ service: "api" });

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = Fastify({ loggerInstance: logger });

  await app.listen({ port, host });
  logger.info({ port, host }, "api listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "api shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "api failed to start");
  process.exit(1);
});
