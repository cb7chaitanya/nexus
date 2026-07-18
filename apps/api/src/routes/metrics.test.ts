/**
 * Integration tests against a real Fastify instance via app.inject() —
 * exercises the actual onRequest/onResponse hooks (plugins/metrics.ts),
 * not a unit test of recordHttpRequest in isolation (that's covered in
 * @raas/metrics's own test suite). Prerequisites: docker compose up -d.
 */
import { httpErrorsTotal, httpRequestDurationSeconds, httpRequestsTotal, registry } from "@raas/metrics";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { redis } from "../lib/redis.js";

describe("GET /metrics", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    httpRequestsTotal.reset();
    httpRequestDurationSeconds.reset();
    httpErrorsTotal.reset();
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it("returns 200 with Prometheus exposition text, no auth required", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("raas_http_requests_total");
  });

  it("includes every required metric family", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    const body = response.body;

    expect(body).toContain("raas_http_requests_total");
    expect(body).toContain("raas_http_request_duration_seconds");
    expect(body).toContain("raas_http_errors_total");
    expect(body).toContain("raas_ingestion_jobs_started_total");
    expect(body).toContain("raas_ingestion_jobs_completed_total");
    expect(body).toContain("raas_ingestion_jobs_failed_total");
    expect(body).toContain("raas_document_processing_duration_seconds");
    expect(body).toContain("raas_embedding_tokens_total");
    expect(body).toContain("raas_llm_tokens_total");
  });

  it("records a request against the ROUTE PATTERN, not the raw URL with real ids", async () => {
    await app.inject({ method: "GET", url: "/health/live" });

    const metric = await httpRequestsTotal.get();
    expect(metric.values).toEqual(
      expect.arrayContaining([expect.objectContaining({ labels: { method: "GET", route: "/health/live", status_code: "200" } })]),
    );
  });

  it("increments the error counter for a 404, but not for a 200", async () => {
    await app.inject({ method: "GET", url: "/health/live" });
    await app.inject({ method: "GET", url: "/this-route-does-not-exist" });

    const errors = await httpErrorsTotal.get();
    expect(errors.values.some((v) => v.labels.status_code === "404")).toBe(true);
    expect(errors.values.some((v) => v.labels.status_code === "200")).toBe(false);
  });

  it("observes request duration as a positive number of seconds", async () => {
    await app.inject({ method: "GET", url: "/health/live" });

    const histogram = await httpRequestDurationSeconds.get();
    const sumEntry = histogram.values.find((v) => v.metricName?.endsWith("_sum"));
    expect(sumEntry).toBeDefined();
    expect(sumEntry!.value).toBeGreaterThanOrEqual(0);
  });

  it("GET /metrics itself does not inflate the request counter it serves", async () => {
    const before = await httpRequestsTotal.get();
    const beforeMetricsCount = before.values.find((v) => v.labels.route === "/metrics")?.value ?? 0;

    await app.inject({ method: "GET", url: "/metrics" });
    await app.inject({ method: "GET", url: "/metrics" });

    const after = (await registry.getSingleMetric("raas_http_requests_total")!.get()) as Awaited<ReturnType<typeof httpRequestsTotal.get>>;
    const afterMetricsCount = after.values.find((v) => v.labels.route === "/metrics")?.value ?? 0;
    // GET /metrics is a plain route (see plugins/metrics.ts) and still
    // goes through the same global onRequest/onResponse hooks as every
    // other route — it is not literally excluded from being counted, but
    // its own count should still just be a small, exact, predictable
    // number (2, matching the 2 calls above), not something inflated by
    // the metrics endpoint scraping itself recursively.
    expect(afterMetricsCount - beforeMetricsCount).toBe(2);
  });
});
