import { API_URL } from "@/lib/config";
import { DocPage, DocSection, EndpointBadge } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "Documents · Docs" };

export default function DocumentsDocPage() {
  return (
    <DocPage
      title="Documents"
      description="What's actually available today via the public API, and what&apos;s dashboard-only for now — no guessing."
    >
      <DocSection title="Uploading (dashboard only, for now)">
        <p>
          Uploading is a dashboard feature: drag a PDF, DOCX, TXT, Markdown, or HTML file into a knowledge base, and
          it moves through <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">QUEUED → EXTRACTING → CHUNKING → EMBEDDING → READY</code>{" "}
          in the background — visible in real time, with a clear failure reason and a retry action if any stage
          fails. Programmatic upload via API key isn&apos;t on the public API yet — if you need it sooner, this is worth
          telling us.
        </p>
      </DocSection>

      <DocSection title="Listing documents">
        <EndpointBadge method="GET" path="/v1/knowledge-bases/:id/documents" />
        <p className="mt-3">
          Returns every non-deleted document in a knowledge base, most recent first, with its current status. Use
          this to poll ingestion progress for documents your team uploaded via the dashboard.
        </p>
        <CodeTabs
          examples={{
            bash: `curl "${API_URL}/v1/knowledge-bases/kb_123/documents?limit=20" \\
  -H "Authorization: Bearer rk_live_..."`,
            javascript: `const res = await fetch(
  \`${API_URL}/v1/knowledge-bases/kb_123/documents?limit=20\`,
  { headers: { Authorization: "Bearer rk_live_..." } }
);
const { data: documents, nextCursor } = await res.json();`,
            python: `import requests

res = requests.get(
    "${API_URL}/v1/knowledge-bases/kb_123/documents",
    headers={"Authorization": "Bearer rk_live_..."},
    params={"limit": 20},
)
documents = res.json()["data"]`,
          }}
        />
        <p>Response:</p>
        <CodeTabs
          examples={{
            json: `{
  "data": [
    {
      "id": "doc_01h...",
      "fileName": "product-handbook.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 482913,
      "status": "READY",
      "failureReason": null,
      "retryCount": 0,
      "createdAt": "2026-07-20T09:12:00.000Z"
    }
  ],
  "nextCursor": null
}`,
          }}
        />
        <p>
          A knowledge base that doesn&apos;t exist — or belongs to a different organization than your key — returns a
          plain <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">404</code>, never a{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">403</code>: whether it&apos;s missing or
          just not yours isn&apos;t something a caller without access should be able to distinguish.
        </p>
      </DocSection>

      <DocSection title="Document status values">
        <ul className="list-disc space-y-1 pl-6">
          <li><code className="rounded bg-muted px-1 py-0.5 font-mono text-small">PENDING_UPLOAD</code> — a presigned URL was issued, bytes haven&apos;t arrived yet</li>
          <li><code className="rounded bg-muted px-1 py-0.5 font-mono text-small">QUEUED</code> · <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">EXTRACTING</code> · <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">CHUNKING</code> · <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">EMBEDDING</code> — actively processing</li>
          <li><code className="rounded bg-muted px-1 py-0.5 font-mono text-small">READY</code> — chunked, embedded, and included in chat retrieval</li>
          <li><code className="rounded bg-muted px-1 py-0.5 font-mono text-small">FAILED</code> — check <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">failureReason</code>; retryable from the dashboard up to a small attempt cap</li>
        </ul>
      </DocSection>
    </DocPage>
  );
}
