WITH ranked_verifications AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY code ORDER BY received_at ASC, id ASC) AS rn
  FROM audit.webhook_verifications
)
DELETE FROM audit.webhook_verifications v
USING ranked_verifications r
WHERE v.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_verifications_code_unique_idx
  ON audit.webhook_verifications (code);

ALTER TABLE audit.webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_status_check;

ALTER TABLE audit.webhook_inbox
  ADD CONSTRAINT webhook_inbox_status_check
  CHECK (status IN ('pending', 'processing', 'processed', 'ignored', 'failed'));

ALTER TABLE audit.webhook_inbox
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS webhook_inbox_claim_idx
  ON audit.webhook_inbox (status, received_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE audit.reconciliation_results
  DROP CONSTRAINT IF EXISTS reconciliation_results_status_check;

ALTER TABLE audit.reconciliation_results
  ADD CONSTRAINT reconciliation_results_status_check
  CHECK (status IN ('imported', 'passed', 'failed'));
