import { baseLogger } from "@raas/logger";

import { buildApp } from "./app.js";
import { env } from "./env.js";

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  app.log.info({ port: env.API_PORT, host: env.API_HOST }, "api listening");

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "api shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  baseLogger.error({ err }, "api failed to start");
  process.exit(1);
});
