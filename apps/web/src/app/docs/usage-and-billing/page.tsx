import Link from "next/link";

import { API_URL } from "@/lib/config";
import { DocPage, DocSection, EndpointBadge } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "Usage & billing · Docs" };

export default function UsageAndBillingDocPage() {
  return (
    <DocPage
      title="Usage & billing"
      description="How usage is measured, and how plans and limits work."
    >
      <DocSection title="Usage">
        <EndpointBadge method="GET" path="/organizations/:id/usage" />
        <p className="mt-3">
          Accepts an optional <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">from</code>/
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">to</code> range (defaults to the
          trailing 30 days, capped at 366 days) and returns totals for the full range plus a paginated daily
          breakdown:
        </p>
        <CodeTabs
          examples={{
            bash: `curl "${API_URL}/organizations/org_123/usage" \\
  -H "Cookie: raas_session=..."`,
            json: `{
  "period": { "from": "2026-06-25T00:00:00.000Z", "to": "2026-07-25T00:00:00.000Z" },
  "totals": {
    "embeddingTokens": 184230,
    "completionTokens": 52110,
    "requestCount": 214,
    "estimatedCost": 1.42
  },
  "breakdown": [
    { "date": "2026-07-24", "eventType": "CHAT_REQUEST", "requestCount": 12, "tokens": 0, "cost": 0 }
  ],
  "nextCursor": null
}`,
          }}
        />
        <p>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">estimatedCost</code> is exactly that —
          an illustrative estimate based on published provider pricing, not a billing statement. It&apos;s computed the
          same way the dashboard&apos;s own usage chart displays it.
        </p>
      </DocSection>

      <DocSection title="Limits">
        <p>
          Every organization has a daily document-processing quota and a daily embedding-token budget, checked
          before the request that would consume them (document completion, and every embedding call — both the
          per-query embedding in chat and the bulk embedding in ingestion) — never after the fact. Chat is
          additionally rate-limited per organization and per user, requests per minute, independent of the daily
          token budget. Hitting a limit returns a normal error response with a code identifying which one, not a
          silent drop.
        </p>
      </DocSection>

      <DocSection title="Plans">
        <p>
          Nexus has three self-serve tiers — Starter, Pro, and Advanced — billed monthly or yearly, with
          country-localized pricing shown at checkout. Current pricing is always accurate on the{" "}
          <Link href="/pricing" className="font-medium text-primary underline underline-offset-2">
            pricing page
          </Link>{" "}
          itself rather than duplicated here, so this doc can&apos;t go stale relative to what you&apos;d actually be charged.
        </p>
        <p>
          Billing runs through Paddle as Merchant of Record. Plan changes are driven by Paddle webhooks — your
          organization&apos;s plan updates automatically once a subscription event is verified, typically within seconds
          of checkout completing.
        </p>
      </DocSection>
    </DocPage>
  );
}
