import { Counter } from "prom-client";

import { registry } from "./registry.js";

// Labeled by model only — never by organizationId. This is a
// multi-tenant SaaS with an open-ended number of organizations
// (docs/architecture.md §0); a per-org label would make this metric's
// cardinality grow without bound as customers sign up, which is exactly
// the failure mode Prometheus labels must avoid. Per-org totals already
// have a real home: the UsageEvent table (packages/usage), queried by
// GET /organizations/:id/usage — metrics are for aggregate operational
// signal, not a second billing ledger.
export const embeddingTokensTotal = new Counter({
  name: "raas_embedding_tokens_total",
  help: "Total embedding tokens consumed, labeled by model",
  labelNames: ["model"] as const,
  registers: [registry],
});

export const llmTokensTotal = new Counter({
  name: "raas_llm_tokens_total",
  help: "Total LLM tokens consumed, labeled by model and kind (prompt|completion)",
  labelNames: ["model", "kind"] as const,
  registers: [registry],
});
