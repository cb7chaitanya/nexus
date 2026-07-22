import Link from "next/link";
import { CheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const tiers = [
  {
    plan: "free",
    name: "Free",
    tagline: "Evaluate Nexus with real documents.",
    features: ["1 knowledge base", "Standard document & request limits", "Full chat + citations experience"],
    cta: { label: "Start building free", href: "/signup" },
    highlighted: false,
  },
  {
    plan: "pro",
    name: "Pro",
    tagline: "For products shipping retrieval to real users.",
    features: ["Multiple knowledge bases", "Higher document & request limits", "Full API access with scoped keys"],
    cta: { label: "Start building free", href: "/signup" },
    highlighted: true,
  },
  {
    plan: "enterprise",
    name: "Enterprise",
    tagline: "For teams with dedicated infrastructure needs.",
    features: ["Custom limits & quotas", "Dedicated support", "Custom deployment options"],
    cta: { label: "Start building free", href: "/signup" },
    highlighted: false,
  },
] as const;

export function PricingSection() {
  return (
    <section id="pricing" className="border-t border-border/60 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">Plans that grow with your product</h2>
          <p className="mt-3 text-muted-foreground text-pretty">
            Every plan starts the same way: create an account and ship your first knowledge base in minutes.
          </p>
        </div>
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {tiers.map((tier) => (
            <Card
              key={tier.plan}
              className={cn("gap-0 p-6", tier.highlighted && "border-primary/50 shadow-sm")}
            >
              <h3 className="text-sm font-semibold">{tier.name}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{tier.tagline}</p>
              <ul className="mt-6 space-y-2.5">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className="mt-8"
                variant={tier.highlighted ? "default" : "outline"}
                asChild
              >
                <Link href={tier.cta.href}>{tier.cta.label}</Link>
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
