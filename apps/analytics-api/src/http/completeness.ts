import type { DbPool } from "../db.js";
import {
  CLOVER_CONFIRMED_CLOSED,
  COMPLETENESS_WARMUP_DAYS,
  completenessCtes
} from "../quality/completeness-sql.js";

export type CompletenessStatus = "present" | "missing" | "closed" | "warming_up" | "not_loaded";

export interface CompletenessDay {
  business_date: string;
  status: CompletenessStatus;
}

export interface CompletenessReport {
  from: string;
  to: string;
  days: CompletenessDay[];
  /** Missing OPEN days older than `from` — the "holes in my 8 years" the windowed grid can't show. */
  olderMissing: number;
  summary: Partial<Record<CompletenessStatus, number>>;
}

interface ReportRow {
  days: CompletenessDay[] | null;
  older_missing: number;
  summary: Partial<Record<CompletenessStatus, number>> | null;
}

// Per-day completeness classification for the ops heatmap. Uses the SAME guards
// as the missing_business_dates DQ check (quality/checks.ts): a day is `missing`
// only if it is open (operating_days mask AND a weekday that has ever produced an
// order), past the 28-day warm-up, interior (<= the store's last loaded day), and
// has zero activity. The spine runs the store's whole history up to `to` so the
// older-holes count covers all years; only the windowed slice is returned as rows.
export async function completenessReport(
  pool: DbPool,
  merchantId: string,
  from: string,
  to: string
): Promise<CompletenessReport> {
  const { rows } = await pool.query<ReportRow>(
    `
      WITH ${completenessCtes("$3::date")},
      classified AS (
        SELECT
          s.business_date,
          CASE
            WHEN a.business_date IS NOT NULL THEN 'present'
            WHEN s.business_date > (SELECT last_data_date FROM bounds) THEN 'not_loaded'
            WHEN ((COALESCE((SELECT operating_days FROM target), 127) >> extract(dow FROM s.business_date)::int) & 1) = 0 THEN 'closed'
            WHEN extract(dow FROM s.business_date)::int NOT IN (SELECT dow FROM open_dows) THEN 'closed'
            WHEN s.business_date < (SELECT start_date FROM bounds) + ${COMPLETENESS_WARMUP_DAYS} THEN 'warming_up'
            -- Cross-stream: external Clover recon confirmed this miss is a real
            -- closure (Clover also had zero) — render closed, not missing.
            WHEN ${CLOVER_CONFIRMED_CLOSED} THEN 'closed'
            ELSE 'missing'
          END AS status
        FROM spine s
        LEFT JOIN activity a ON a.business_date = s.business_date
      )
      SELECT
        (
          SELECT json_agg(
            json_build_object('business_date', to_char(business_date, 'YYYY-MM-DD'), 'status', status)
            ORDER BY business_date
          )
          FROM classified
          WHERE business_date >= $2::date
        ) AS days,
        (
          SELECT count(*)::int
          FROM classified
          WHERE business_date < $2::date AND status = 'missing'
        ) AS older_missing,
        (
          SELECT json_object_agg(status, n)
          FROM (SELECT status, count(*) AS n FROM classified WHERE business_date >= $2::date GROUP BY status) x
        ) AS summary
    `,
    [merchantId, from, to]
  );

  const row = rows[0];
  return {
    from,
    to,
    days: row?.days ?? [],
    olderMissing: Number(row?.older_missing ?? 0),
    summary: row?.summary ?? {}
  };
}
