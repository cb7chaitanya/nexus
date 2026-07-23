const steps = [
  {
    step: "01",
    title: "Upload",
    description:
      "Drop in PDFs, DOCX, TXT, Markdown, or HTML. Nexus validates and extracts every file automatically.",
  },
  {
    step: "02",
    title: "Chunk & embed",
    description:
      "Documents are split into retrieval-sized chunks and embedded in the background — no pipeline to build or operate.",
  },
  {
    step: "03",
    title: "Retrieve & generate",
    description:
      "Every question retrieves the exact passages that matter, then generates an answer grounded in them.",
  },
  {
    step: "04",
    title: "Cite",
    description:
      "Each claim links back to the source passage and page it came from — verifiable, not just plausible.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-border/60 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className="max-w-xl text-h2 text-balance">Every answer, traced back to its source</h2>
        <p className="mt-3 max-w-xl text-muted-foreground text-pretty">
          The same pipeline shown above runs on every single request — nothing
          skipped, nothing simulated.
        </p>
        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((item) => (
            <div key={item.step}>
              <p className="font-mono text-small text-muted-foreground">{item.step}</p>
              <h3 className="mt-2 text-h4">{item.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
