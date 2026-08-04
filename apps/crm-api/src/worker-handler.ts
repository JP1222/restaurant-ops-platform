import { CRM_LOYALTY_ACCRUAL_QUEUE, OrderCompletedEventSchema } from "@rop/contracts";
import type { Prisma } from "@rop/db-crm";

import { accrueFromOrderCompleted, type AccrualResult } from "./domain/accrual.js";
import { normalizeE164 } from "./domain/phone.js";
import type { AppServices } from "./lib/services.js";

/**
 * Process one `crm-loyalty-accrual` job: validate the wire payload, canonicalize
 * the phone, and turn it into ledger movement (idempotently). Kept separate from
 * `worker.ts` (the BullMQ bootstrap) so it has **no import side-effects** and can
 * be unit-tested directly — mirrors kds-api's `lib/queue/handlers.ts` split.
 *
 * - **Validate at the boundary.** A malformed job is a programming/contract
 *   error, so we `parse` (throw) rather than silently skip — BullMQ then retries
 *   and finally dead-letters it, surfacing the bug instead of swallowing money.
 * - **Canonicalize here, not at the producer.** kds-api ferries the provider's
 *   loose phone; crm-api is the identity owner, so E.164 normalization happens at
 *   this chokepoint (ADR-0024). A phone that can't be canonicalized becomes
 *   `null` → the accrual skips it as anonymous (no throw — a bad customer phone
 *   is not a retryable failure).
 */
export async function processAccrualJob(services: AppServices, data: unknown): Promise<AccrualResult> {
  const event = OrderCompletedEventSchema.parse(data);
  const phoneE164 = event.phoneE164 ? normalizeE164(event.phoneE164) : null;
  return accrueFromOrderCompleted(services.prisma, { ...event, phoneE164 });
}

/** The subset of a BullMQ Job the dead-letter builder needs (structural so it's testable without a real Job). */
export interface FailedAccrualJobView {
  attemptsMade: number;
  opts?: { attempts?: number };
  data?: unknown;
}

export type CrmDeadLetterRow = {
  merchantId: string | null;
  jobType: string;
  reason: string;
  attempts: number;
  payload: Prisma.InputJsonValue;
};

/**
 * GH #467: build the dead-letter row for a failed accrual job, or `null` when the
 * job still has retries left (only the FINAL attempt is persisted — earlier ones
 * will be retried). The phone (PII) is stripped from the stored payload per the
 * crm logging rule; `merchantId` is preserved for forensics/replay. Kept here
 * (not in worker.ts) so it has no Redis import side-effect and is unit-testable.
 */
export function deadLetterRowForFailedAccrual(
  job: FailedAccrualJobView | undefined,
  error: unknown
): CrmDeadLetterRow | null {
  if (!job) {
    return null;
  }
  const maxAttempts = job.opts?.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) {
    return null;
  }
  const data = (job.data ?? {}) as Record<string, unknown>;
  const redactedPayload: Record<string, unknown> = { ...data };
  delete redactedPayload.phoneE164;
  return {
    merchantId: typeof data.merchantId === "string" ? data.merchantId : null,
    jobType: CRM_LOYALTY_ACCRUAL_QUEUE,
    reason: error instanceof Error ? error.message : String(error),
    attempts: job.attemptsMade,
    payload: redactedPayload as Prisma.InputJsonValue
  };
}
