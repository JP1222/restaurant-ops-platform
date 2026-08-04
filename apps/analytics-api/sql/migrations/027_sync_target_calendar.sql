-- P1 calendar completeness (data-completeness roadmap): give each store an
-- explicit open/backfill anchor and a weekly operating-days mask so the
-- missing-business-date check can tell a real gap from a closed day WITHOUT any
-- empirical-inference machinery.
--
-- open_date: the store's first operating / backfill day. When NULL the
--   completeness check falls back to the earliest day that actually has data in
--   the mart, so an existing store (store #1, 8 years of history) needs no
--   manual value. A brand-new store sets it at onboarding so its pre-open
--   calendar is never flagged as missing, and its first 28 days are a warm-up.
-- operating_days: a 7-bit weekday mask. Bit i (0 = Sunday .. 6 = Saturday) set
--   means the store is open that weekday. Default 127 = open every day. It is an
--   EXPLICIT override; the check ALSO auto-treats any weekday that has never
--   produced an order as closed, so a correct default needs no operator action
--   for an existing store. Forward-only; ADD COLUMN IF NOT EXISTS is re-runnable.

ALTER TABLE config.sync_targets
  ADD COLUMN IF NOT EXISTS open_date date;

ALTER TABLE config.sync_targets
  ADD COLUMN IF NOT EXISTS operating_days smallint NOT NULL DEFAULT 127;
