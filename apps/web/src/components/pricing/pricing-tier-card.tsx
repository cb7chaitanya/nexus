import { CheckIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Tier } from "@/lib/tiers";

export function PricingTierCard({
  tier,
  formattedTotal,
  interval,
  onSubscribe,
  loading,
}: {
  tier: Tier;
  formattedTotal: string | undefined;
  interval: "month" | "year";
  onSubscribe: () => void;
  loading: boolean;
}) {
  return (
    <Card className={cn("gap-0 p-6", tier.highlighted && "border-primary/50")}>
      <h3 className="text-h4">{tier.name}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{tier.description}</p>

      <div className="mt-6 flex items-baseline gap-1">
        {formattedTotal ? (
          <span className="text-h2 tabular-nums">{formattedTotal}</span>
        ) : (
          <span className="text-h2 text-muted-foreground">···</span>
        )}
        <span className="text-sm text-muted-foreground">/{interval === "month" ? "mo" : "yr"}</span>
      </div>

      <ul className="mt-6 space-y-2.5">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
            {feature}
          </li>
        ))}
      </ul>

      <Button className="mt-8" variant={tier.highlighted ? "default" : "outline"} onClick={onSubscribe} disabled={loading}>
        {loading && <Loader2Icon className="animate-spin" />}
        Subscribe
      </Button>
    </Card>
  );
}
