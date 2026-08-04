ALTER TABLE audit.webhook_inbox
  ADD COLUMN IF NOT EXISTS run_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS last_recovered_at timestamptz;

DROP INDEX IF EXISTS audit.webhook_inbox_claim_idx;

CREATE INDEX IF NOT EXISTS webhook_inbox_claim_idx
  ON audit.webhook_inbox (status, run_after, received_at)
  WHERE status IN ('pending', 'processing');
