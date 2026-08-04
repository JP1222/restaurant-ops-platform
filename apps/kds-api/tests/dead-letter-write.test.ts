import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { writeDeadLetterForFailedJob } from "../src/lib/queue/handlers.js";
import { kdsDeadLetterWriteFailuresTotal } from "../src/lib/metrics.js";

function makeJob(overrides: Partial<Job<unknown>> = {}): Job<unknown> {
  return {
    name: "sync-order",
    queueName: "kds-sync",
    id: "job-1",
    data: { merchantId: "merchant-1", sourceOrderId: "order-1" },
    attemptsMade: 5,
    opts: { attempts: 5 },
    ...overrides
  } as unknown as Job<unknown>;
}

function makeServices(create: ReturnType<typeof vi.fn>) {
  return { prisma: { deadLetterJob: { create } } } as never;
}

describe("writeDeadLetterForFailedJob (GH #462)", () => {
  it("retries the dead-letter write before giving up", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("db blip"))
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({});

    await writeDeadLetterForFailedJob(makeServices(create), makeJob(), new Error("job failed"));

    expect(create).toHaveBeenCalledTimes(3); // two transient failures, third succeeds
  });

  it("surfaces a lost dead-letter row on the metric after exhausting retries", async () => {
    const create = vi.fn().mockRejectedValue(new Error("db down"));
    const before = (await kdsDeadLetterWriteFailuresTotal.get()).values
      .filter((v) => v.labels.job_type === "sync-order")
      .reduce((sum, v) => sum + v.value, 0);

    await expect(
      writeDeadLetterForFailedJob(makeServices(create), makeJob(), new Error("job failed"))
    ).rejects.toThrow("db down");

    expect(create).toHaveBeenCalledTimes(3);
    const after = (await kdsDeadLetterWriteFailuresTotal.get()).values
      .filter((v) => v.labels.job_type === "sync-order")
      .reduce((sum, v) => sum + v.value, 0);
    expect(after).toBe(before + 1);
  });

  it("skips jobs that have not exhausted their attempts", async () => {
    const create = vi.fn();
    await writeDeadLetterForFailedJob(
      makeServices(create),
      makeJob({ attemptsMade: 1, opts: { attempts: 5 } as Job["opts"] }),
      new Error("transient")
    );
    expect(create).not.toHaveBeenCalled();
  });
});
