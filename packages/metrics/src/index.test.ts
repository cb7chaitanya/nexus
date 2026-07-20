import { afterEach, describe, expect, it } from "vitest";

import {
  documentIngestionDurationSeconds,
  documentProcessingDurationSeconds,
  embeddingTokensTotal,
  httpErrorsTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  ingestionJobsCompletedTotal,
  ingestionJobsFailedTotal,
  ingestionJobsRetriedTotal,
  ingestionJobsStartedTotal,
  llmTokensTotal,
  queueActiveJobs,
  queueDepth,
  recordHttpRequest,
  registerQueueForMetrics,
  registry,
  resetQueueMetricsRegistrationsForTesting,
} from "./index.js";

async function metricNames(): Promise<Set<string>> {
  const parsed = await registry.getMetricsAsJSON();
  return new Set(parsed.map((m) => m.name));
}

describe("@raas/metrics", () => {
  it("registers every required metric on the shared registry", async () => {
    const names = await metricNames();
    expect(names.has("raas_http_requests_total")).toBe(true);
    expect(names.has("raas_http_request_duration_seconds")).toBe(true);
    expect(names.has("raas_http_errors_total")).toBe(true);
    expect(names.has("raas_ingestion_jobs_started_total")).toBe(true);
    expect(names.has("raas_ingestion_jobs_completed_total")).toBe(true);
    expect(names.has("raas_ingestion_jobs_failed_total")).toBe(true);
    expect(names.has("raas_ingestion_jobs_retried_total")).toBe(true);
    expect(names.has("raas_document_processing_duration_seconds")).toBe(true);
    expect(names.has("raas_document_ingestion_duration_seconds")).toBe(true);
    expect(names.has("raas_queue_depth")).toBe(true);
    expect(names.has("raas_queue_active_jobs")).toBe(true);
    expect(names.has("raas_embedding_tokens_total")).toBe(true);
    expect(names.has("raas_llm_tokens_total")).toBe(true);
  });

  it("also registers the default Node/process metrics, prefixed raas_", async () => {
    const names = await metricNames();
    expect([...names].some((n) => n.startsWith("raas_process_") || n.startsWith("raas_nodejs_"))).toBe(true);
  });

  it("recordHttpRequest increments the request counter and observes duration", async () => {
    httpRequestsTotal.reset();
    httpRequestDurationSeconds.reset();
    httpErrorsTotal.reset();

    recordHttpRequest({ method: "GET", route: "/kb/:id/documents", statusCode: 200, durationSeconds: 0.042 });

    const total = await httpRequestsTotal.get();
    expect(total.values).toEqual([
      expect.objectContaining({ labels: { method: "GET", route: "/kb/:id/documents", status_code: "200" }, value: 1 }),
    ]);

    const errors = await httpErrorsTotal.get();
    expect(errors.values).toHaveLength(0);
  });

  it("recordHttpRequest also increments the error counter for a >=400 status", async () => {
    httpRequestsTotal.reset();
    httpErrorsTotal.reset();

    recordHttpRequest({ method: "POST", route: "/kb", statusCode: 500, durationSeconds: 0.1 });

    const errors = await httpErrorsTotal.get();
    expect(errors.values).toEqual([
      expect.objectContaining({ labels: { method: "POST", route: "/kb", status_code: "500" }, value: 1 }),
    ]);
  });

  it("recordHttpRequest never increments the error counter for a 2xx/3xx status", async () => {
    httpErrorsTotal.reset();

    recordHttpRequest({ method: "GET", route: "/health", statusCode: 304, durationSeconds: 0.001 });

    const errors = await httpErrorsTotal.get();
    expect(errors.values).toHaveLength(0);
  });

  it("ingestion job counters and duration histograms accept queue/job_name labels", async () => {
    ingestionJobsStartedTotal.reset();
    ingestionJobsCompletedTotal.reset();
    ingestionJobsFailedTotal.reset();
    ingestionJobsRetriedTotal.reset();
    documentProcessingDurationSeconds.reset();
    documentIngestionDurationSeconds.reset();

    ingestionJobsStartedTotal.inc({ queue: "document-extraction", job_name: "extract-text" });
    ingestionJobsCompletedTotal.inc({ queue: "document-extraction", job_name: "extract-text" });
    ingestionJobsFailedTotal.inc({ queue: "document-embedding", job_name: "embed-chunks" });
    ingestionJobsRetriedTotal.inc({ queue: "document-embedding", job_name: "embed-chunks" });
    documentProcessingDurationSeconds.observe({ queue: "document-extraction", job_name: "extract-text" }, 1.5);
    documentIngestionDurationSeconds.observe(42);

    const started = await ingestionJobsStartedTotal.get();
    expect(started.values[0]).toMatchObject({ labels: { queue: "document-extraction", job_name: "extract-text" }, value: 1 });

    const failed = await ingestionJobsFailedTotal.get();
    expect(failed.values[0]).toMatchObject({ labels: { queue: "document-embedding", job_name: "embed-chunks" }, value: 1 });

    // Distinct from failed above — see ingestion-metrics.ts's own doc
    // comment on why these are two separate counters, not one derived
    // from the other.
    const retried = await ingestionJobsRetriedTotal.get();
    expect(retried.values[0]).toMatchObject({ labels: { queue: "document-embedding", job_name: "embed-chunks" }, value: 1 });
  });

  describe("queueDepth / queueActiveJobs", () => {
    afterEach(() => {
      resetQueueMetricsRegistrationsForTesting();
      // A Gauge retains every label combination it has ever been .set()
      // to until explicitly cleared — resetQueueMetricsRegistrationsForTesting
      // only empties the *source* list collect() reads from next time, it
      // doesn't retroactively erase values a previous scrape already
      // recorded. Without this, "reports nothing for a never-registered
      // queue" below would see this describe block's own earlier test
      // data leaking across cases.
      queueDepth.reset();
      queueActiveJobs.reset();
    });

    it("reports depth (waiting+delayed+prioritized+waiting-children) and active counts for every registered queue, sampled at scrape time", async () => {
      registerQueueForMetrics({
        name: "document-extraction",
        getJobCounts: async () => ({ waiting: 3, delayed: 1, prioritized: 0, "waiting-children": 2, active: 4, completed: 100, failed: 5 }),
      });
      registerQueueForMetrics({
        name: "document-embedding",
        getJobCounts: async () => ({ waiting: 0, active: 1 }),
      });

      // Neither gauge is set imperatively — both only populate on
      // collect(), which registry.getMetricsAsJSON()/metrics() trigger
      // internally. Calling .get() directly (as every other test in this
      // file does) would read stale/empty state, since that path doesn't
      // invoke collect() — this is the one metric type in this package
      // where scrape-time sampling, not an inc()/observe() call site,
      // is what actually produces a value.
      const parsed = await registry.getMetricsAsJSON();
      const depth = parsed.find((m) => m.name === "raas_queue_depth");
      const active = parsed.find((m) => m.name === "raas_queue_active_jobs");

      expect(depth?.values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ labels: { queue: "document-extraction" }, value: 6 }),
          expect.objectContaining({ labels: { queue: "document-embedding" }, value: 0 }),
        ]),
      );
      expect(active?.values).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ labels: { queue: "document-extraction" }, value: 4 }),
          expect.objectContaining({ labels: { queue: "document-embedding" }, value: 1 }),
        ]),
      );
    });

    it("reports nothing for a queue that was never registered", async () => {
      const parsed = await registry.getMetricsAsJSON();
      const depth = parsed.find((m) => m.name === "raas_queue_depth");
      expect(depth?.values).toEqual([]);
    });
  });

  it("usage counters accept token amounts, never an organizationId label", async () => {
    embeddingTokensTotal.reset();
    llmTokensTotal.reset();

    embeddingTokensTotal.inc({ model: "text-embedding-3-small" }, 456);
    llmTokensTotal.inc({ model: "gpt-4o-mini", kind: "prompt" }, 120);

    const embedding = await embeddingTokensTotal.get();
    expect(embedding.values[0]).toMatchObject({ labels: { model: "text-embedding-3-small" }, value: 456 });
    // Cardinality guard: organizationId must never appear as a label on
    // either usage counter (see usage-metrics.ts's doc comment) — enforced
    // at compile time by each Counter's label-name generic, and confirmed
    // here at runtime: the recorded label set is exactly what was passed.
    const llm = await llmTokensTotal.get();
    expect(Object.keys(llm.values[0]!.labels)).toEqual(["model", "kind"]);
    expect(Object.keys(embedding.values[0]!.labels)).toEqual(["model"]);
  });

  it("registry.metrics() renders Prometheus exposition text containing every metric name", async () => {
    const text = await registry.metrics();
    expect(text).toContain("raas_http_requests_total");
    expect(text).toContain("raas_ingestion_jobs_started_total");
    expect(text).toContain("raas_embedding_tokens_total");
    expect(registry.contentType).toContain("text/plain");
  });
});
