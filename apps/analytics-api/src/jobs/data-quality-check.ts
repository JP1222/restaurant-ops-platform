import type { DbPool } from "../db.js";
import type { SyncJob } from "../scheduler/job-repository.js";
import { asJsonRecord } from "./shared.js";
import { runDataQualityChecks } from "../quality/checks.js";

export async function runDataQualityJob(pool: DbPool, job: SyncJob) {
  const payload = asJsonRecord(job.payload);
  const start = typeof payload.start === "string" ? new Date(payload.start) : undefined;
  const end = typeof payload.end === "string" ? new Date(payload.end) : undefined;
  const result = await runDataQualityChecks(pool, job.merchantId, start, end);
  return {
    rowsRead: result.rowsRead,
    rowsWritten: result.rowsWritten,
    dirtyWindowCount: 0,
    outputTables: ["audit.data_quality_checks"],
    metadata: {
      failedCount: result.failedCount
    },
    warning: result.failedCount > 0
  };
}
