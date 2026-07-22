import { Environment, Paddle } from "@paddle/paddle-node-sdk";

import { env } from "../env.js";

// Only constructed when billing is actually configured — routes/billing.ts
// only registers its routes when env.PADDLE_API_KEY is set, so this module
// is only ever imported (and this thrown) from that guarded path.
if (!env.PADDLE_API_KEY) {
  throw new Error("paddle-client.ts imported without PADDLE_API_KEY set — this should be unreachable.");
}

export const paddle = new Paddle(env.PADDLE_API_KEY, {
  environment: env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox,
});
