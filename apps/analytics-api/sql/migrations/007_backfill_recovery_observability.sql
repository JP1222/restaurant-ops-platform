ALTER TABLE audit.sync_windows
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_after timestamptz,
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;

DO $$
DECLARE
  status_constraint_name text;
BEGIN
  SELECT conname
  INTO status_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'audit.sync_windows'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%'
    AND pg_get_constraintdef(oid) LIKE '%pending%'
  LIMIT 1;

  IF status_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE audit.sync_windows DROP CONSTRAINT %I', status_constraint_name);
  END IF;
END $$;

ALTER TABLE audit.sync_windows
  ADD CONSTRAINT sync_windows_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'warning', 'failed', 'blocked'));

CREATE INDEX IF NOT EXISTS sync_windows_historical_retry_idx
  ON audit.sync_windows (merchant_id, window_start, retry_after)
  WHERE window_type = 'historical_export_backfill'
    AND status IN ('failed', 'blocked');
