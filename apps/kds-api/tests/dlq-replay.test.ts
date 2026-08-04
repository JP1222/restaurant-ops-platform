import { describe, expect, it, vi } from "vitest";
import {
  NotReplayableError,
  replayDeadLetterJob,
  type ReplayQueue
} from "../src/lib/dlq-replay.js";

// GH #124 / ADR-0727: replay re-enqueues the stored job onto its original queue,
// and refuses (NotReplayableError) job types it won't re-drive.

function fakeQueue() {
  return {
    enqueueBulk: vi.fn(async () => {}),
    enqueueFulfillment: vi.fn(async () => {})
  } satisfies ReplayQueue;
}

const SYNC_DATA = { provider: "CLOVER", merchantId: "M1", sourceOrderId: "o1", reason: "reconciliation" };
const FULFILL_DATA = { ticketId: "t1", action: "bump", occurredAt: "2026-06-17T00:00:00Z", ticketUpdatedAt: "2026-06-17T00:00:00Z" };

describe("replayDeadLetterJob (GH #124 / ADR-0727)", () => {
  it("re-enqueues a sync-order job onto the sync queue", async () => {
    const q = fakeQueue();
    await replayDeadLetterJob(q, {
      jobType: "sync-order",
      payload: { queue: "kds-sync-hi", jobId: "1", data: SYNC_DATA }
    });
    expect(q.enqueueBulk).toHaveBeenCalledWith([SYNC_DATA]);
    expect(q.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it("re-enqueues a push-fulfillment job onto the fulfillment queue", async () => {
    const q = fakeQueue();
    await replayDeadLetterJob(q, {
      jobType: "push-fulfillment",
      payload: { queue: "kds-fulfillment", jobId: "2", data: FULFILL_DATA }
    });
    expect(q.enqueueFulfillment).toHaveBeenCalledWith(FULFILL_DATA);
    expect(q.enqueueBulk).not.toHaveBeenCalled();
  });

  it("refuses a scheduler job type (reschedules itself) without enqueuing", async () => {
    const q = fakeQueue();
    await expect(
      replayDeadLetterJob(q, { jobType: "reconciliation", payload: { data: { task: "reconciliation" } } })
    ).rejects.toBeInstanceOf(NotReplayableError);
    expect(q.enqueueBulk).not.toHaveBeenCalled();
    expect(q.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it("refuses a row whose payload has no re-enqueueable data (e.g. provider-fulfillment-enqueue)", async () => {
    const q = fakeQueue();
    await expect(
      replayDeadLetterJob(q, {
        jobType: "provider-fulfillment-enqueue",
        payload: { ticketId: "t1", action: "bump" }
      })
    ).rejects.toBeInstanceOf(NotReplayableError);
    expect(q.enqueueBulk).not.toHaveBeenCalled();
  });
});
