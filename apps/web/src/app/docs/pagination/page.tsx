import { API_URL } from "@/lib/config";
import { DocPage, DocSection } from "@/components/docs/doc-page";
import { CodeTabs } from "@/components/docs/code-tabs";

export const metadata = { title: "Pagination · Docs" };

export default function PaginationDocPage() {
  return (
    <DocPage
      title="Pagination"
      description="Every list endpoint in the API — public and dashboard alike — uses the same cursor-based pagination. Learn it once."
    >
      <DocSection title="Request">
        <p>
          Two optional query parameters: <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">cursor</code>{" "}
          (the id of the last item you saw) and{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">limit</code> (1–100, default 20).
        </p>
      </DocSection>

      <DocSection title="Response">
        <CodeTabs
          examples={{
            json: `{
  "data": [ /* up to \`limit\` items */ ],
  "nextCursor": "doc_01h..." // or null when this was the last page
}`,
          }}
        />
        <p>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">nextCursor</code> is only present when
          the page was completely full — a short page always means there&apos;s nothing left to fetch, so you never have
          to make one extra request just to find that out.
        </p>
      </DocSection>

      <DocSection title="Paging through everything">
        <CodeTabs
          examples={{
            javascript: `let cursor;
const all = [];

do {
  const url = new URL("${API_URL}/v1/knowledge-bases/kb_123/documents");
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url, { headers: { Authorization: "Bearer rk_live_..." } });
  const page = await res.json();
  all.push(...page.data);
  cursor = page.nextCursor;
} while (cursor);`,
            python: `import requests

cursor = None
all_documents = []

while True:
    params = {"limit": 100, **({"cursor": cursor} if cursor else {})}
    res = requests.get(
        "${API_URL}/v1/knowledge-bases/kb_123/documents",
        headers={"Authorization": "Bearer rk_live_..."},
        params=params,
    )
    page = res.json()
    all_documents.extend(page["data"])
    cursor = page["nextCursor"]
    if not cursor:
        break`,
          }}
        />
      </DocSection>
    </DocPage>
  );
}
