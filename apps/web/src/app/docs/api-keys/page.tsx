import Link from "next/link";

import { DocPage, DocSection, EndpointBadge } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "API keys · Docs" };

export default function ApiKeysDocPage() {
  return (
    <DocPage
      title="API keys"
      description="Keys are created and managed from the dashboard, not the API itself — creating a key is a privileged, session-authenticated action, deliberately not something a leaked bearer token could ever do to itself."
    >
      <DocSection title="Create a key">
        <p>
          Go to{" "}
          <Link href="/settings/api-keys" className="font-medium text-primary underline underline-offset-2">
            Settings → API keys
          </Link>
          . You&apos;ll need to be an organization owner or admin. Give it a name you&apos;ll recognize later (which API
          consumer is this? which environment?) and an optional expiry.
        </p>
        <p>
          The raw key — <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">rk_live_...</code> — is
          shown exactly once, in that creation response. Store it somewhere real (a secrets manager, not a Slack
          message) — Nexus never stores it in a recoverable form, only a SHA-256 hash. If you lose it, revoke it and
          create a new one; there&apos;s no &quot;show key again.&quot;
        </p>
      </DocSection>

      <DocSection title="What a key can do">
        <p>
          A key is scoped to one organization, all-or-nothing — there&apos;s no per-key read/write or per-KB scoping
          today. Anyone holding the key can do anything the public API supports for that organization. Treat it like
          a password, not a public identifier: never commit it, never send it from a browser.
        </p>
      </DocSection>

      <DocSection title="Revoke a key">
        <EndpointBadge method="DELETE" path="/organizations/:id/api-keys/:keyId" />
        <p className="mt-3">
          Revocation is checked on every request — there&apos;s no cache window where a revoked key keeps working. Do
          this immediately if a key leaks; there&apos;s no faster mitigation available.
        </p>
      </DocSection>

      <DocSection title="List your keys">
        <EndpointBadge method="GET" path="/organizations/:id/api-keys" />
        <p className="mt-3">
          Returns the prefix and metadata for every key — never the raw value again. Paginated; see{" "}
          <Link href="/docs/pagination" className="font-medium text-primary underline underline-offset-2">
            Pagination
          </Link>
          .
        </p>
        <CodeTabs
          examples={{
            json: `{
  "data": [
    {
      "id": "ak_01h...",
      "name": "Production server",
      "prefix": "rk_live_ab12",
      "lastUsedAt": "2026-07-20T14:02:11.000Z",
      "expiresAt": null,
      "revokedAt": null,
      "createdAt": "2026-06-01T09:00:00.000Z"
    }
  ],
  "nextCursor": null
}`,
          }}
        />
      </DocSection>
    </DocPage>
  );
}
