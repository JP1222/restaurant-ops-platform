import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { CloverClient } from "../clover/client.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord, fetchOrderByWebhook, fetchPaymentByWebhook, parseEventTs } from "./shared.js";

export async function runWebhookFetchJob(
  pool: DbPool,
  config: AppConfig,
  clover: CloverClient,
  job: SyncJob
) {
  const payload = asJsonRecord(job.payload);
  const eventTs = parseEventTs(payload.eventTs);
  if (job.jobType === "webhook_fetch_order") {
    return fetchOrderByWebhook(pool, config, clover, job.merchantId, String(payload.orderId), eventTs);
  }
  if (job.jobType === "webhook_fetch_payment") {
    return fetchPaymentByWebhook(pool, config, clover, job.merchantId, String(payload.paymentId), eventTs);
  }
  throw new Error(`Unsupported webhook fetch job: ${job.jobType}`);
}
