import { API_URL } from "@/lib/config";
import { DocPage, DocSection } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "Authentication · Docs" };

export default function AuthenticationPage() {
  return (
    <DocPage
      title="Authentication"
      description="The public API is authenticated with a bearer API key. The dashboard is authenticated with a session cookie. They're separate mechanisms — neither one weakens the other."
    >
      <DocSection title="API keys (public API)">
        <p>
          Send your key as a standard bearer token on every request:
        </p>
        <CodeTabs
          examples={{
            bash: `curl "${API_URL}/v1/knowledge-bases/kb_123/documents" \\
  -H "Authorization: Bearer rk_live_..."`,
          }}
        />
        <p>
          A key resolves directly to the organization it belongs to — there&apos;s no separate organization ID to pass
          alongside it, and no way for a request authenticated with one organization&apos;s key to reach another
          organization&apos;s data, regardless of what IDs appear in the URL. An invalid, revoked, or expired key all
          return the same <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">401 UNAUTHORIZED</code>{" "}
          — the response deliberately doesn&apos;t distinguish which case you hit.
        </p>
      </DocSection>

      <DocSection title="Session cookies (dashboard)">
        <p>
          The dashboard signs in with email + a one-time code (or Google, if your organization has it enabled) and
          authenticates every subsequent request with an httpOnly session cookie — not a token your own code should
          ever generate or forward. If you&apos;re integrating programmatically, use an API key instead.
        </p>
      </DocSection>

      <DocSection title="Error shape">
        <p>Every error from the API — auth failures included — has the same shape:</p>
        <CodeTabs
          examples={{
            json: `{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}`,
          }}
        />
      </DocSection>
    </DocPage>
  );
}
