import { Environment, Paddle } from "@paddle/paddle-node-sdk";

import { env } from "../env.js";

// Lazily constructed, NOT at module scope — this module is statically
// imported by routes/billing.ts, and a static ES module import is
// evaluated eagerly regardless of any runtime guard around the code that
// uses it (routes/billing.ts's own "only register when PADDLE_API_KEY is
// set" check does not stop this module from loading). Constructing (or
// throwing) here at import time would crash every deployment that hasn't
// configured Paddle, not just skip billing — verified the hard way in
// production. getPaddleClient() defers both until the first call, which
// only ever happens from inside a route handler billing.ts doesn't
// register at all when Paddle is unconfigured.
let client: Paddle | undefined;

export function getPaddleClient(): Paddle {
  if (!client) {
    if (!env.PADDLE_API_KEY) {
      throw new Error("getPaddleClient() called without PADDLE_API_KEY set — this should be unreachable.");
    }
    client = new Paddle(env.PADDLE_API_KEY, {
      environment: env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox,
    });
  }
  return client;
}
