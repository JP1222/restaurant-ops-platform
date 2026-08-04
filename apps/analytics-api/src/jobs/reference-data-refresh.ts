import type { DbPool } from "../db.js";
import { CloverClient } from "../clover/client.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord, refreshReferenceData } from "./shared.js";

export async function runReferenceDataRefreshJob(pool: DbPool, clover: CloverClient, job: SyncJob) {
  const payload = asJsonRecord(job.payload);
  const resource = payload.resource === "employees" || payload.resource === "tenders" || payload.resource === "order_types"
    ? payload.resource
    : "all";
  return refreshReferenceData(pool, clover, job.merchantId, resource);
}
