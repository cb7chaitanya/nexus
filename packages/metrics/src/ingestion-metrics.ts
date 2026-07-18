import { Counter, Histogram } from "prom-client";

import { registry } from "./registry.js";

// Labeled by queue/job_name — the BullMQ queue and job name a stage runs
// as (e.g. queue "document-extraction", job_name "extract-text"), not by
// organizationId/documentId: those are per-tenant/per-item identifiers
// with unbounded cardinality, exactly what a label must never carry (see
// http-metrics.ts's route label comment for the same reasoning). Per-item
// detail belongs in logs (apps/worker/src/lib/job-logger.ts), not metrics.
const jobLabelNames = ["queue", "job_name"] as const;

export const ingestionJobsStartedTotal = new Counter({
  name: "raas_ingestion_jobs_started_total",
  help: "Total ingestion pipeline jobs that started processing (BullMQ 'active' event)",
  labelNames: jobLabelNames,
  registers: [registry],
});

export const ingestionJobsCompletedTotal = new Counter({
  name: "raas_ingestion_jobs_completed_total",
  help: "Total ingestion pipeline jobs that completed successfully",
  labelNames: jobLabelNames,
  registers: [registry],
});

// BullMQ emits "failed" on every failed ATTEMPT, not just the final one
// (see apps/worker/src/lib/job-failure-alerts.ts's own doc comment on this
// exact semantic) — this counter mirrors that faithfully rather than
// trying to only count permanent failures, so its help text says so
// explicitly instead of silently under- or over-representing retries.
export const ingestionJobsFailedTotal = new Counter({
  name: "raas_ingestion_jobs_failed_total",
  help: "Total ingestion pipeline job attempts that failed, including attempts that will still be retried",
  labelNames: jobLabelNames,
  registers: [registry],
});

export const documentProcessingDurationSeconds = new Histogram({
  name: "raas_document_processing_duration_seconds",
  help: "Duration of a single ingestion pipeline job's own processing time (BullMQ processedOn to finishedOn), labeled by queue/job_name",
  labelNames: jobLabelNames,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

// Distinct from documentProcessingDurationSeconds above: this is the
// END-TO-END duration of one document's whole ingestion flow (upload-
// confirmed to READY/FAILED), not one internal BullMQ job's own
// processing slice. Recorded once per document, off the process-document
// job specifically (see apps/worker/src/index.ts) — that job only ever
// completes once every descendant (chunk-text's subtree, every fanned-out
// embed-chunks batch) has finished, so its own (timestamp -> finishedOn)
// span covers the real, full pipeline duration a customer would perceive.
export const documentIngestionDurationSeconds = new Histogram({
  name: "raas_document_ingestion_duration_seconds",
  help: "End-to-end duration of one document's full ingestion pipeline, from enqueue to the whole flow completing",
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});
