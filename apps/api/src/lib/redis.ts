import { Redis } from "ioredis";

import { env } from "../env.js";

// Session revocation store — this is the ONLY thing in this codebase that
// makes packages/auth's stateless JWT verification into a real, revocable
// session. packages/auth itself never touches Redis; only apps/api does
// (see lib/session.ts). Not shared with apps/worker's own Redis
// connection — each process owns its own client.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});
