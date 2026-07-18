import { Counter, Histogram } from "prom-client";

import { registry } from "./registry.js";

export const httpRequestsTotal = new Counter({
  name: "raas_http_requests_total",
  help: "Total HTTP requests handled, labeled by method/route/status_code",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "raas_http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method/route/status_code",
  labelNames: ["method", "route", "status_code"] as const,
  // Tuned for a JSON API: sub-10ms to a generous 10s tail (e.g. a slow
  // upstream embedding/LLM call on the chat path), not a page-load-shaped
  // bucket set.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// >=400 covers both 4xx and 5xx in one counter — status_code stays a
// label on every event, so a dashboard/alert can still split "client
// errors" from "server errors" post-hoc (e.g. status_code=~"5..") without
// this package guessing which distinction a given deployment cares about.
export const httpErrorsTotal = new Counter({
  name: "raas_http_errors_total",
  help: "Total HTTP responses with a 4xx or 5xx status code, labeled by method/route/status_code",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export interface HttpRequestObservation {
  method: string;
  /** The matched route PATTERN (e.g. "/kb/:id/documents"), never the raw
   * URL with real path params — using the raw URL would give every
   * distinct document/org id its own label value, an unbounded-cardinality
   * time series that would eventually take down whatever scrapes this. */
  route: string;
  statusCode: number;
  durationSeconds: number;
}

export function recordHttpRequest(observation: HttpRequestObservation): void {
  const labels = {
    method: observation.method,
    route: observation.route,
    status_code: String(observation.statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, observation.durationSeconds);
  if (observation.statusCode >= 400) {
    httpErrorsTotal.inc(labels);
  }
}
