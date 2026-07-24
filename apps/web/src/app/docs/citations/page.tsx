import { DocPage, DocSection } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "Citations · Docs" };

export default function CitationsDocPage() {
  return (
    <DocPage
      title="Citations"
      description="Every claim in a Nexus answer traces back to a real, retrieved passage — not a paraphrase, and not something the model asserted unverified."
    >
      <DocSection title="Shape">
        <p>
          Each message that streams back carries a structured citations array alongside its text. A citation is
          never just a footnote number — it resolves to the actual document and passage:
        </p>
        <CodeTabs
          examples={{
            json: `{
  "refId": "1",
  "chunkId": "chk_01h...",
  "documentId": "doc_01h...",
  "pageNumber": 14,
  "quote": "Refunds are issued within 5 business days of..."
}`,
          }}
        />
      </DocSection>

      <DocSection title="How a citation earns its place">
        <p>
          The model is instructed to cite the reference id of any retrieved chunk it draws on, inline, as it
          generates. That&apos;s a claim, not a guarantee — so after generation completes, every citation marker in the
          output is checked against the chunk IDs that were actually included in context for that request. Anything
          that doesn&apos;t resolve is stripped before the response is considered final. A citation you see in a Nexus
          answer is one the system independently confirmed, not one the model merely asserted.
        </p>
      </DocSection>

      <DocSection title="In the UI">
        <p>
          Citation markers render inline as small numbered badges; hovering or clicking one opens the exact quoted
          passage plus a page reference, so &quot;trust me&quot; is never the only option a reader has.
        </p>
      </DocSection>
    </DocPage>
  );
}
