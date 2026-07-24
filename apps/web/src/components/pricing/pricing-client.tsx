"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { usePaddle } from "@/hooks/use-paddle";
import { TIERS } from "@/lib/tiers";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { PricingTierCard } from "@/components/pricing/pricing-tier-card";

export function PricingClient({
  isAuthenticated,
  organizationId,
  email,
  countryCode,
}: {
  isAuthenticated: boolean;
  organizationId: string | undefined;
  email: string | undefined;
  countryCode: string | undefined;
}) {
  const router = useRouter();
  const paddle = usePaddle();
  const [interval, setInterval] = useState<"month" | "year">("month");
  // priceId -> Paddle's own formatted total string (e.g. "$20.00") — never
  // reformatted or recomputed locally, per Paddle's own guidance that only
  // the server (here, Paddle's pricing-preview API) knows the real total
  // once tax/currency conversion/discounts are applied.
  const [totals, setTotals] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!paddle) return;
    let cancelled = false;

    paddle
      .PricePreview({
        items: TIERS.map((tier) => ({ priceId: tier.priceId[interval], quantity: 1 })),
        address: countryCode ? { countryCode } : undefined,
      })
      .then((response) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const lineItem of response.data.details.lineItems) {
          next[lineItem.price.id] = lineItem.formattedTotals.total;
        }
        setTotals(next);
      })
      .catch(() => {
        // A failed preview just leaves totals showing the "···" loading
        // placeholder — Subscribe still works (Paddle's own overlay
        // computes and displays the real price at checkout regardless).
      });

    return () => {
      cancelled = true;
    };
  }, [paddle, interval, countryCode]);

  function handleSubscribe(priceId: string) {
    if (!isAuthenticated || !organizationId) {
      router.push("/signup");
      return;
    }
    if (!paddle) return;

    paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customer: email ? { email } : undefined,
      customData: { organizationId },
      settings: {
        displayMode: "overlay",
        variant: "one-page",
        successUrl: `${window.location.origin}/welcome`,
      },
    });
  }

  return (
    <section className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
      <div className="max-w-xl">
        <h1 className="text-h1 text-balance">Plans that grow with your product</h1>
        <p className="mt-3 text-muted-foreground text-pretty">
          Every plan starts the same way: create an account and ship your first knowledge base in minutes.
        </p>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <span className={interval === "month" ? "text-sm font-medium" : "text-sm text-muted-foreground"}>Monthly</span>
        <Switch
          checked={interval === "year"}
          onCheckedChange={(checked) => setInterval(checked ? "year" : "month")}
          aria-label="Toggle yearly billing"
        />
        <span className={interval === "year" ? "text-sm font-medium" : "text-sm text-muted-foreground"}>Yearly</span>
        <Badge variant="success">2 months free</Badge>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {TIERS.map((tier) => {
          const priceId = tier.priceId[interval];
          return (
            <PricingTierCard
              key={tier.name}
              tier={tier}
              interval={interval}
              formattedTotal={totals[priceId]}
              loading={!paddle}
              onSubscribe={() => handleSubscribe(priceId)}
            />
          );
        })}
      </div>
    </section>
  );
}
