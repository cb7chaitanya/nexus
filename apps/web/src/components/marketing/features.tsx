import {
  DatabaseIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  ShieldCheckIcon,
  UploadCloudIcon,
  UsersIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";

const storyFeatures = [
  {
    icon: MessagesSquareIcon,
    title: "Grounded, cited chat",
    description:
      "Every answer streams in real time and links back to the exact source passages it was built from — not a paraphrase, the actual quote and page.",
  },
  {
    icon: DatabaseIcon,
    title: "Isolated knowledge bases",
    description:
      "Organize documents into knowledge bases per product, team, or customer, each with its own independent retrieval scope — nothing bleeds across boundaries.",
  },
];

const supportingFeatures = [
  {
    icon: UploadCloudIcon,
    title: "Ingest in seconds",
    description:
      "Drag in PDFs and documents. Chunking, embedding, and indexing happen automatically in the background.",
  },
  {
    icon: UsersIcon,
    title: "Team workspaces",
    description:
      "Invite teammates, assign roles, and collaborate on the same knowledge base with org-level access control.",
  },
  {
    icon: KeyRoundIcon,
    title: "API-first",
    description:
      "Every dashboard action has a matching API. Generate scoped keys and integrate retrieval into your own product.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Usage you can trust",
    description:
      "Track tokens, requests, and estimated cost per organization with daily budgets and rate limits built in.",
  },
];

export function Features() {
  return (
    <section id="features" className="border-t border-border/60 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">
            Everything you need to ship RAG, nothing you have to build yourself
          </h2>
          <p className="mt-3 text-muted-foreground text-pretty">
            Focus on your product. We handle the retrieval infrastructure underneath it.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          {storyFeatures.map((feature) => (
            <Card key={feature.title} interactive className="gap-0 p-8">
              <div className="flex size-11 items-center justify-center rounded-lg bg-secondary text-foreground">
                <feature.icon className="size-5" />
              </div>
              <h3 className="mt-5 text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{feature.description}</p>
            </Card>
          ))}
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {supportingFeatures.map((feature) => (
            <Card key={feature.title} interactive className="gap-0 p-6">
              <div className="flex size-9 items-center justify-center rounded-lg bg-secondary text-foreground">
                <feature.icon className="size-4.5" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{feature.description}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
