import type { SyncOrderJob, FulfillmentJob } from "./queue.js";
import type { SyncQueue } from "./queue.js";

// GH #124 / ADR-0727: a DeadLetterJob row is replayed by re-enqueuing its stored
// job onto the original queue (the row already captures everything). The payload
// shape written by writeDeadLetterForFailedJob (worker.ts) is:
//   { queue, jobId, data: <original job data> }
// keyed by `jobType` = the BullMQ job name.
export interface DeadLetterRowForReplay {
  jobType: string;
  payload: unknown;
}

// A queue with just the enqueue methods replay needs — structural so the helper
// is unit-testable without a real SyncQueue / Redis.
export type ReplayQueue = Pick<SyncQueue, "enqueueBulk" | "enqueueFulfillment">;

export class NotReplayableError extends Error {
  constructor(jobType: string) {
    super(
      `Job type '${jobType}' is not replayable via the DLQ endpoint — scheduler jobs reschedule themselves, and other types need manual handling. Use /resolve instead.`
    );
    this.name = "NotReplayableError";
  }
}

function payloadData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data?: unknown }).data;
  }
  return undefined;
}

/**
 * Re-enqueue a dead-lettered job onto its original queue. Throws
 * NotReplayableError for job types this endpoint won't re-drive (scheduler
 * recurring jobs, loyalty accrual, or the fulfillment-enqueue record whose
 * payload isn't a re-enqueueable job). Replay is safe to repeat: sync jobs
 * dedup on a deterministic key and the sync upsert is idempotent (ADR-0727).
 */
export async function replayDeadLetterJob(
  queue: ReplayQueue,
  row: DeadLetterRowForReplay
): Promise<void> {
  const data = payloadData(row.payload);
  if (data === undefined || data === null) {
    throw new NotReplayableError(row.jobType);
  }
  switch (row.jobType) {
    case "sync-order":
      await queue.enqueueBulk([data as SyncOrderJob]);
      return;
    case "push-fulfillment":
      await queue.enqueueFulfillment(data as FulfillmentJob);
      return;
    default:
      throw new NotReplayableError(row.jobType);
  }
}
