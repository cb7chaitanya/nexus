export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const SESSION_COOKIE_NAME = "raas_session";

export const ACTIVE_ORG_COOKIE_NAME = "raas_active_org";

// Paddle billing (components/billing/paddle-checkout-button.tsx) — both
// unset is a legitimate, supported state (billing simply isn't enabled;
// mirrors apps/api's own PADDLE_API_KEY being fully optional). The price
// id has to live here too, separate from the API's own PADDLE_PRO_PRICE_ID
// — one is read server-side (Fastify env), the other client-side (Next.js
// NEXT_PUBLIC_ env) — both must be set to the same real Paddle Price id.
export const PADDLE_CLIENT_TOKEN = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
export const PADDLE_PRO_PRICE_ID = process.env.NEXT_PUBLIC_PADDLE_PRO_PRICE_ID;
// Without this, Paddle.js defaults to production regardless of what kind
// of token it was given — a sandbox token initialized with no explicit
// environment fails checkout with a generic "Something went wrong" (see
// paddle-checkout-button.tsx's handleClick), not an error that names the
// actual mismatch.
export const PADDLE_ENVIRONMENT = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT;
