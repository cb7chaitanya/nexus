import {
  DatabaseIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  ShieldCheckIcon,
  UploadCloudIcon,
  UsersIcon,
} from "lucide-react";

const features = [
  {
    icon: UploadCloudIcon,
    title: "Ingest in seconds",
    description:
      "Drag in PDFs and documents. Chunking, embedding, and indexing happen automatically in the background.",
  },
  {
    icon: MessagesSquareIcon,
    title: "Grounded, cited chat",
    description:
      "Every answer streams in real time and links back to the exact source passages it was built from.",
  },
  {
    icon: DatabaseIcon,
    title: "Isolated knowledge bases",
    description:
      "Organize documents into knowledge bases per product, team, or customer with independent retrieval scopes.",
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
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/30"
            >
              <div className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <feature.icon className="size-4.5" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
