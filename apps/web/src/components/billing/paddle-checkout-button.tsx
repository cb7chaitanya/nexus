"use client";

import { useState, type ComponentProps } from "react";
import Script from "next/script";

import { PADDLE_CLIENT_TOKEN, PADDLE_PRO_PRICE_ID } from "@/lib/config";
import { Button } from "@/components/ui/button";

// window.Paddle's type now comes from @paddle/paddle-js's own global
// augmentation (installed for the /pricing page) — no local declaration
// needed here anymore, and declaring a second, narrower one would conflict
// with it.
let paddleInitialized = false;

/**
 * Renders nothing when billing isn't configured (PADDLE_CLIENT_TOKEN/
 * PADDLE_PRO_PRICE_ID unset) — same "simply not there" shape as every
 * other optional-feature gate in this app, rather than a disabled button
 * that goes nowhere.
 */
export function PaddleCheckoutButton({
  organizationId,
  email,
  ...buttonProps
}: { organizationId: string; email: string } & ComponentProps<typeof Button>) {
  const [scriptReady, setScriptReady] = useState(false);

  if (!PADDLE_CLIENT_TOKEN || !PADDLE_PRO_PRICE_ID) {
    return null;
  }

  function handleClick() {
    if (!window.Paddle) return;
    if (!paddleInitialized) {
      window.Paddle.Initialize({ token: PADDLE_CLIENT_TOKEN! });
      paddleInitialized = true;
    }
    // customData is copied onto the resulting transaction and subscription,
    // and shows up in every webhook as data.customData — this is how
    // routes/billing.ts's webhook handler maps a Paddle event back to this
    // organization, with no separate "create Paddle customer first" step.
    window.Paddle.Checkout.open({
      items: [{ priceId: PADDLE_PRO_PRICE_ID!, quantity: 1 }],
      customData: { organizationId },
      customer: { email },
    });
  }

  return (
    <>
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="lazyOnload" onLoad={() => setScriptReady(true)} />
      <Button {...buttonProps} disabled={!scriptReady || buttonProps.disabled} onClick={handleClick} />
    </>
  );
}
