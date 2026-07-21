const steps = [
  {
    step: "01",
    title: "Create a knowledge base",
    description: "Spin one up per project or customer. Embeddings are configured automatically.",
  },
  {
    step: "02",
    title: "Upload your documents",
    description: "PDFs and text files are extracted, chunked, and embedded in the background.",
  },
  {
    step: "03",
    title: "Chat, cited by default",
    description: "Ask questions and get streamed, source-linked answers — in the dashboard or your API.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-border/60 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-balance">
          From documents to answers in three steps
        </h2>
        <div className="mt-12 grid gap-8 sm:grid-cols-3">
          {steps.map((item) => (
            <div key={item.step}>
              <span className="text-sm font-mono text-primary">{item.step}</span>
              <h3 className="mt-3 text-base font-semibold">{item.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
