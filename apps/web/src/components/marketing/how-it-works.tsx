import { PipelineDemo } from "@/components/marketing/pipeline-demo";

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-border/60 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-balance">
          Every answer, traced back to its source
        </h2>
        <p className="mt-3 max-w-xl text-muted-foreground text-pretty">
          This is the real pipeline running behind every request — documents are ingested,
          chunked, embedded, and retrieved before a single token is generated.
        </p>
        <div className="mt-12">
          <PipelineDemo />
        </div>
      </div>
    </section>
  );
}
