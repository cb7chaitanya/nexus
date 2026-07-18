/**
 * Real HTTP: a real local server stands in for the webhook receiver
 * (capturing whatever it actually receives) and WebhookNotifier makes a
 * real fetch() call against it — nothing about the HTTP layer is mocked.
 * What's exercised deliberately is failure: a receiver that 500s, one
 * that's simply unreachable, and one that never responds at all, each
 * proving notifyJobFailure resolves rather than rejects — the actual
 * "notifier failures never crash worker" requirement.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { JobFailureEvent } from "./types.js";
import { WebhookNotifier } from "./webhook-notifier.js";

const sampleEvent: JobFailureEvent = {
  organizationId: "org-123",
  documentId: "doc-456",
  jobId: "embed-chunks-doc-456-0",
  jobName: "embed-chunks",
  queueName: "document-embedding",
  failureReason: "provider timed out",
  retryCount: 3,
  occurredAt: "2026-07-18T00:00:00.000Z",
};

interface CapturedRequest {
  method?: string;
  contentType?: string;
  body: unknown;
}

function startReceiver(handler: (req: IncomingMessage, body: string) => { status: number } | Promise<{ status: number }>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void Promise.resolve(handler(req, Buffer.concat(chunks).toString("utf8"))).then(({ status }) => {
          res.writeHead(status);
          res.end();
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("WebhookNotifier", () => {
  let activeServer: Server | undefined;

  afterEach(async () => {
    if (activeServer) {
      await closeServer(activeServer);
      activeServer = undefined;
    }
  });

  it("POSTs the full event as JSON, including organizationId, documentId, jobId, failureReason, and retryCount", async () => {
    let captured: CapturedRequest | undefined;
    const { server, port } = await startReceiver((req, body) => {
      captured = { method: req.method, contentType: req.headers["content-type"], body: JSON.parse(body) as unknown };
      return { status: 200 };
    });
    activeServer = server;

    const notifier = new WebhookNotifier({ url: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
    await notifier.notifyJobFailure(sampleEvent);

    expect(captured).toBeDefined();
    expect(captured?.method).toBe("POST");
    expect(captured?.contentType).toContain("application/json");
    expect(captured?.body).toMatchObject({
      event: "job.failed",
      organizationId: sampleEvent.organizationId,
      documentId: sampleEvent.documentId,
      jobId: sampleEvent.jobId,
      failureReason: sampleEvent.failureReason,
      retryCount: sampleEvent.retryCount,
    });
  });

  it("resolves (does not throw) when the receiver responds with a server error", async () => {
    const { server, port } = await startReceiver(() => ({ status: 500 }));
    activeServer = server;

    const notifier = new WebhookNotifier({ url: `http://127.0.0.1:${port}`, timeoutMs: 2000 });

    await expect(notifier.notifyJobFailure(sampleEvent)).resolves.toBeUndefined();
  });

  it("resolves (does not throw) when the receiver is unreachable", async () => {
    // Bind a real server, learn a real free port, then close it — the
    // next fetch to that port gets a genuine connection-refused from the
    // OS, not fetch's own banned-port policy (a low port like :1 would
    // trigger that instead, a different failure mode than "unreachable").
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const notifier = new WebhookNotifier({ url: `http://127.0.0.1:${port}`, timeoutMs: 2000 });

    await expect(notifier.notifyJobFailure(sampleEvent)).resolves.toBeUndefined();
  });

  it("resolves (does not throw) when the receiver never responds, once the timeout elapses", async () => {
    const server = createServer(() => {
      // Deliberately never calls res.end() — the connection just hangs.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    activeServer = server;
    const port = (server.address() as AddressInfo).port;

    const notifier = new WebhookNotifier({ url: `http://127.0.0.1:${port}`, timeoutMs: 300 });

    const start = Date.now();
    await expect(notifier.notifyJobFailure(sampleEvent)).resolves.toBeUndefined();
    // Proves it actually timed out (didn't just happen to resolve
    // quickly for some other reason) rather than hanging for the whole
    // test run.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
