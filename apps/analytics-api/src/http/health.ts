import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbPool } from "../db.js";

export async function handleHealth(res: ServerResponse) {
  respondJson(res, 200, { ok: true });
}

export async function handleReady(res: ServerResponse, pool: DbPool) {
  try {
    await pool.query("SELECT 1");
    const heartbeat = await pool.query<{ fresh: boolean; missing: string[] | null }>(
      `
        WITH required(component) AS (
          VALUES
            ('realtime-runner'),
            ('export-runner'),
            ('hydration-runner'),
            ('repair-runner'),
            ('dq-runner'),
            ('scheduler'),
            ('mart-refresh-worker'),
            ('webhook-inbox-worker')
        )
        SELECT
          count(h.component) = 8
            AND COALESCE(bool_and(h.last_seen_at >= now() - interval '2 minutes'), false) AS fresh,
          array_agg(required.component ORDER BY required.component)
            FILTER (
              WHERE h.component IS NULL
                 OR h.last_seen_at < now() - interval '2 minutes'
            ) AS missing
        FROM required
        LEFT JOIN audit.service_heartbeats h ON h.component = required.component
      `
    );
    const hourly = await pool.query<{ fresh: boolean }>(
      `
        SELECT COALESCE(max(completed_at) >= now() - interval '90 minutes', true) AS fresh
        FROM audit.sync_runs
        WHERE job_type = 'hourly_rest_sweep'
          AND status = 'completed'
      `
    );
    const ready = heartbeat.rows[0]?.fresh === true && hourly.rows[0]?.fresh === true;
    respondJson(res, ready ? 200 : 503, {
      ok: ready,
      db: true,
      heartbeatFresh: heartbeat.rows[0]?.fresh === true,
      hourlyFresh: hourly.rows[0]?.fresh === true,
      missingHeartbeats: heartbeat.rows[0]?.missing ?? []
    });
  } catch (error) {
    respondJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function respondJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
