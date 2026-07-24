import type { ReactNode } from "react";

export function DocPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <article>
      <h1 className="text-h1">{title}</h1>
      <p className="mt-2 text-body text-muted-foreground">{description}</p>
      <div className="mt-8 space-y-8 text-body [&_h2]:text-h3 [&_h2]:mt-2 [&_h3]:text-h4 [&_p]:text-muted-foreground [&_li]:text-muted-foreground">
        {children}
      </div>
    </article>
  );
}

export function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function EndpointBadge({ method, path }: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }) {
  const color =
    method === "GET"
      ? "bg-success/15 text-success"
      : method === "POST"
        ? "bg-primary/15 text-primary"
        : method === "DELETE"
          ? "bg-destructive/15 text-destructive"
          : "bg-warning/20 text-warning";

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 font-mono text-small">
      <span className={`rounded px-1.5 py-0.5 font-semibold ${color}`}>{method}</span>
      <span className="text-foreground">{path}</span>
    </div>
  );
}
