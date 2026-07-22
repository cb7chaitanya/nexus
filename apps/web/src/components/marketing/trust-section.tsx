import { ActivityIcon, GaugeIcon, QuoteIcon, ShieldIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

const guarantees = [
  {
    icon: ShieldIcon,
    title: "Isolated by design",
    description:
      "Every organization's data lives in its own row-level-secured slice of the database — enforced at the database layer, not just application code.",
  },
  {
    icon: QuoteIcon,
    title: "Citations you can verify",
    description:
      "Every source cited in an answer is checked against the documents actually retrieved for that request. If a claim isn't backed by your documents, it isn't cited.",
  },
  {
    icon: ActivityIcon,
    title: "Nothing fails silently",
    description:
      "Failed or stuck document processing shows up immediately in your dashboard and knowledge base — not in a support ticket three weeks later.",
  },
  {
    icon: GaugeIcon,
    title: "Built to be operated",
    description:
      "Scoped API keys, per-organization rate limits and quotas, and usage tracked down to the token — the controls a real production system needs.",
  },
];

export function TrustSection() {
  return (
    <section id="architecture" className="border-t border-border/60 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">
            Trust is an architecture decision, not a marketing page
          </h2>
          <p className="mt-3 text-muted-foreground text-pretty">
            These are guarantees the system enforces, not claims we make.
          </p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {guarantees.map((item) => (
            <Card key={item.title} interactive className="gap-0 p-6">
              <div className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <item.icon className="size-4.5" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">{item.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{item.description}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
