/**
 * Integration test against real Redis (BullMQ, for a realistic Job
 * object) — no live Worker involved, same "Queue#add as a Job-object
 * factory" pattern as cleanup-document-storage.test.ts. Runs with
 * EMAIL_PROVIDER=fake (see root .env), so this exercises the real
 * getEmailProvider() singleton against FakeEmailProvider, not a mock.
 */
import { JOB_NAMES, QUEUE_NAMES } from "@raas/shared";
import { Queue } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";

import { redisConnection } from "../lib/redis.js";
import { sendEmailProcessor, type SendEmailJobData } from "./send-email.js";

const queue = new Queue<SendEmailJobData>(QUEUE_NAMES.email, { connection: redisConnection });

afterAll(async () => {
  await queue.close();
});

describe("sendEmailProcessor", () => {
  it("delivers the job's message via the configured EmailProvider", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const job = await queue.add(JOB_NAMES.sendTransactionalEmail, {
      to: "processor-test@example.com",
      subject: "Your code",
      html: "<p>654321</p>",
      text: "Your verification code is 654321.",
    });

    await sendEmailProcessor(job);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("processor-test@example.com"));
    logSpy.mockRestore();
  });
});
