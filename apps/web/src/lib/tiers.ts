// Throws at module load rather than silently rendering a broken pricing
// page — this module is only ever imported by the pricing page/its client
// components, so the failure surfaces immediately as a render error
// instead of a checkout button that quietly does nothing.
//
// Next.js only inlines NEXT_PUBLIC_ vars into the client bundle when they
// appear as a literal `process.env.NEXT_PUBLIC_X` expression — a dynamic
// `process.env[name]` lookup is invisible to its build-time replacement
// and would always read as undefined in the browser. So this helper takes
// the already-accessed value, not the var name to look up.
function requirePublicEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set. Refusing to render pricing.`);
  }
  return value;
}

export interface Tier {
  name: "Starter" | "Pro" | "Advanced";
  description: string;
  features: string[];
  priceId: { month: string; year: string };
  highlighted?: boolean;
}

export const TIERS: Tier[] = [
  {
    name: "Starter",
    description: "Evaluate Nexus with real documents.",
    features: ["1 knowledge base", "Standard document & request limits", "Full chat + citations experience"],
    priceId: {
      month: requirePublicEnv("NEXT_PUBLIC_PADDLE_PRICE_STARTER_MONTHLY", process.env.NEXT_PUBLIC_PADDLE_PRICE_STARTER_MONTHLY),
      year: requirePublicEnv("NEXT_PUBLIC_PADDLE_PRICE_STARTER_YEARLY", process.env.NEXT_PUBLIC_PADDLE_PRICE_STARTER_YEARLY),
    },
  },
  {
    name: "Pro",
    description: "For products shipping retrieval to real users.",
    features: ["Multiple knowledge bases", "Higher document & request limits", "Full API access with scoped keys"],
    priceId: {
      month: requirePublicEnv("NEXT_PUBLIC_PADDLE_PRICE_PRO_MONTHLY", process.env.NEXT_PUBLIC_PADDLE_PRICE_PRO_MONTHLY),
      year: requirePublicEnv("NEXT_PUBLIC_PADDLE_PRICE_PRO_YEARLY", process.env.NEXT_PUBLIC_PADDLE_PRICE_PRO_YEARLY),
    },
    highlighted: true,
  },
  {
    name: "Advanced",
    description: "For teams with dedicated infrastructure needs.",
    features: ["Custom limits & quotas", "Priority support", "Highest document & request limits"],
    priceId: {
      month: requirePublicEnv("NEXT_PUBLIC_PADDLE_PRICE_ADVANCED_MONTHLY", process.env.NEXT_PUBLIC_PADDLE_PRICE_ADVANCED_MONTHLY),
      year: requirePublicEnv("NEXT_PUBLIC_PADDLE_PRICE_ADVANCED_YEARLY", process.env.NEXT_PUBLIC_PADDLE_PRICE_ADVANCED_YEARLY),
    },
  },
];
