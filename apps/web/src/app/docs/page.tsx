import Link from "next/link";

import { API_URL } from "@/lib/config";
import { DocPage, DocSection } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "Docs" };

export default function DocsQuickstartPage() {
  return (
    <DocPage
      title="Quickstart"
      description="Nexus turns a folder of documents into a grounded, cited chat API. This page gets you from an API key to a real request."
    >
      <DocSection title="1. Create an API key">
        <p>
          API keys are created from the dashboard under{" "}
          <Link href="/settings/api-keys" className="font-medium text-primary underline underline-offset-2">
            Settings → API keys
          </Link>{" "}
          — organization owners and admins only. The raw key is shown exactly once; only a hash is ever stored
          after that, so if you lose it you&apos;ll need to revoke it and create a new one. See{" "}
          <Link href="/docs/api-keys" className="font-medium text-primary underline underline-offset-2">
            API keys
          </Link>{" "}
          for the full reference.
        </p>
      </DocSection>

      <DocSection title="2. Authenticate a request">
        <p>
          Every request to the public API is authenticated with <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">Authorization: Bearer &lt;key&gt;</code>. There
          is no separate client ID, no OAuth handshake — the key is the credential.
        </p>
      </DocSection>

      <DocSection title="3. Make your first request">
        <p>List the documents in a knowledge base:</p>
        <CodeTabs
          examples={{
            bash: `curl "${API_URL}/v1/knowledge-bases/kb_123/documents" \\
  -H "Authorization: Bearer rk_live_..."`,
            javascript: `const res = await fetch(
  "${API_URL}/v1/knowledge-bases/kb_123/documents",
  { headers: { Authorization: "Bearer rk_live_..." } }
);
const { data, nextCursor } = await res.json();`,
            python: `import requests

res = requests.get(
    "${API_URL}/v1/knowledge-bases/kb_123/documents",
    headers={"Authorization": "Bearer rk_live_..."},
)
data, next_cursor = res.json()["data"], res.json()["nextCursor"]`,
          }}
        />
      </DocSection>

      <DocSection title="Where the rest happens">
        <p>
          Uploading documents and chatting are dashboard features today — see{" "}
          <Link href="/docs/documents" className="font-medium text-primary underline underline-offset-2">
            Documents
          </Link>{" "}
          and{" "}
          <Link href="/docs/chat" className="font-medium text-primary underline underline-offset-2">
            Chat
          </Link>{" "}
          for exactly what&apos;s available via the public API today versus the dashboard, so you&apos;re never guessing.
        </p>
      </DocSection>
    </DocPage>
  );
}
