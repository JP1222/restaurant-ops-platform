\pset pager off
\echo '== sync health =='
SELECT *
FROM audit.sync_health
ORDER BY merchant_id;

\echo '== jobs by type/status =='
SELECT job_type, status, count(*)::integer AS count
FROM audit.sync_jobs
GROUP BY job_type, status
ORDER BY job_type, status;

\echo '== historical backfill windows =='
SELECT merchant_id,
       status,
       count(*)::integer AS count,
       min(window_start) AS first_window,
       max(window_end) AS last_window,
       min(retry_after) FILTER (WHERE retry_after > now()) AS next_retry_after,
       max(blocked_at) AS latest_blocked_at
FROM audit.sync_windows
WHERE window_type = 'historical_export_backfill'
GROUP BY merchant_id, status
ORDER BY merchant_id, status;

\echo '== active historical jobs =='
SELECT merchant_id, status, count(*)::integer AS count
FROM audit.sync_jobs
WHERE job_type = 'historical_export_backfill'
  AND status IN ('pending', 'running')
GROUP BY merchant_id, status
ORDER BY merchant_id, status;

\echo '== recent failed jobs =='
SELECT job_type, merchant_id, window_start, window_end, attempt_count, max_attempts, left(last_error, 240) AS last_error, updated_at
FROM audit.sync_jobs
WHERE status = 'failed'
ORDER BY updated_at DESC
LIMIT 20;

\echo '== dirty windows =='
SELECT merchant_id, status, count(*)::integer AS count, min(created_at) AS oldest_created_at
FROM audit.dirty_windows
GROUP BY merchant_id, status
ORDER BY merchant_id, status;

\echo '== open data quality checks =='
SELECT merchant_id, check_name, status, severity, details, last_seen_at
FROM audit.data_quality_checks
WHERE resolved_at IS NULL
  AND status <> 'passed'
ORDER BY last_seen_at DESC
LIMIT 20;
