"use client";

import { useEffect, useState } from "react";
import { initializePaddle, type Environments, type Paddle } from "@paddle/paddle-js";

// No default for either var — a misconfigured deployment must fail loudly
// (blank pricing page) rather than silently defaulting to sandbox and
// letting a would-be paying customer complete a checkout that was never
// going to charge them, or the reverse. Both are literal `process.env.X`
// accesses (not a dynamic lookup) so Next.js's build-time inlining can see
// them — see lib/tiers.ts's own comment on the same constraint.
const CLIENT_TOKEN = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
const ENVIRONMENT = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT as Environments | undefined;

/** Lazily initializes @paddle/paddle-js once per page and returns the
 * Paddle instance once ready — `undefined` while loading. */
export function usePaddle(): Paddle | undefined {
  const [paddle, setPaddle] = useState<Paddle | undefined>(undefined);

  useEffect(() => {
    if (!CLIENT_TOKEN) throw new Error("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set. Refusing to initialize Paddle.");
    if (!ENVIRONMENT) throw new Error("NEXT_PUBLIC_PADDLE_ENVIRONMENT is not set. Refusing to initialize Paddle.");

    let cancelled = false;
    void initializePaddle({ token: CLIENT_TOKEN, environment: ENVIRONMENT }).then((instance) => {
      if (!cancelled) setPaddle(instance);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return paddle;
}
