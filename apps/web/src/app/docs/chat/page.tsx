import { DocPage, DocSection, EndpointBadge } from "@/components/docs/doc-page";

export const metadata = { title: "Chat · Docs" };

export default function ChatDocPage() {
  return (
    <DocPage
      title="Chat"
      description="How grounded chat works today, and exactly what&apos;s exposed to the public API versus the dashboard."
    >
      <DocSection title="Dashboard chat (session-authenticated)">
        <EndpointBadge method="POST" path="/kb/:id/chat" />
        <p className="mt-3">
          The dashboard&apos;s chat runs through this endpoint, authenticated by session cookie, not an API key. On every
          message: the query is embedded with the same model the knowledge base was built with, a pgvector
          similarity search scoped to your organization and that knowledge base pulls the top candidates, and the
          assembled context is sent to the LLM with a system prompt that requires inline citation markers tied to
          real chunk IDs. The response streams back over Server-Sent Events as it&apos;s generated.
        </p>
      </DocSection>

      <DocSection title="Citation verification isn&apos;t optional">
        <p>
          After the model finishes generating, every citation marker in its output is checked against the chunk IDs
          that were actually placed in context for that specific request. A citation that doesn&apos;t resolve is
          stripped — the model claiming a source it wasn&apos;t given is treated as a bug to catch, not a UI detail to
          gloss over. See{" "}
          <a href="/docs/citations" className="font-medium text-primary underline underline-offset-2">
            Citations
          </a>{" "}
          for the shape this produces.
        </p>
      </DocSection>

      <DocSection title="Public API (not yet available)">
        <p>
          Programmatic chat via API key — <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">POST /v1/knowledge-bases/:id/chat</code> — isn&apos;t
          shipped yet. Today&apos;s public API surface is read-only (see{" "}
          <a href="/docs/documents" className="font-medium text-primary underline underline-offset-2">
            Documents
          </a>
          ). If your integration needs programmatic chat, that&apos;s worth telling us — it&apos;s the next thing on the
          public-API roadmap.
        </p>
      </DocSection>
    </DocPage>
  );
}
