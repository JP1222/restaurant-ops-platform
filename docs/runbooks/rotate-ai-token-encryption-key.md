# Runbook: Rotate `AI_TOKEN_ENCRYPTION_KEY` (at-rest master key)

> Audience: repo owner / on-call operator. Read top-to-bottom **before** starting — this is destructive if rushed.
> Last reviewed: 2026-06-18 · Companion to [OPERATIONS.md §7 Security & Secrets](../../OPERATIONS.md#7-security--secrets).

## What this key is, and why rotation is delicate

`AI_TOKEN_ENCRYPTION_KEY` is the AES-256-GCM master key that encrypts POS provider
secrets **at rest in db-kds** — the `*Cipher` columns on `clover_merchants`,
`pos_accounts`, and `kds_provider_configs` (Deliverect). It is an Infisical
Layer-1 secret (one value, `prod` path `/`), read at runtime by
`apps/kds-api/src/lib/crypto/encryption.ts` `getKey()`.

**The trap:** `getKey()` reads a **single** key — there is no decrypt-with-previous
fallback today. A naive swap (change the Infisical value + restart) makes every
existing ciphertext **permanently unreadable**: the new key cannot decrypt rows
written under the old one, and the cipher is the *only* copy (the plaintext
columns are blanked, and dropped entirely once #787 lands). Orphaned ciphertext =
the operator must re-enter every POS credential by hand.

Rotate **only after a suspected key compromise or operator turnover** — never on a
schedule (the audit explicitly rejects automating this).

## Which variant

| Variant | Needs | Downtime |
|---|---|---|
| **A — flag-day re-encrypt** (works against today's single-key code) | a one-off re-encrypt script + a short kds window | ~minutes |
| **B — zero-downtime** | the `_PREVIOUS` decrypt-fallback in `encryption.ts` (audit P3-1 — **not built yet**) | none |

Until P3-1 ships, use **Variant A**.

## Variant A — flag-day re-encrypt (today)

0. **Back up first.** Confirm a current db-kds backup exists (the nightly R2 dump
   is the floor). The `*Cipher` rows are the only copy of the tokens.
1. **Generate the new key:**
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → 64-char hex.
2. **Stage BOTH keys in Infisical** (`prod`, path `/`): leave `AI_TOKEN_ENCRYPTION_KEY`
   (old) in place, add `AI_TOKEN_ENCRYPTION_KEY_NEXT` = new. Staging both lets the
   re-encrypt script read old + new in one process.
3. **Write the one-off re-encrypt script.** Model it on the P1-6 cipher-backfill
   (`apps/kds-api/src/scripts/backfill-pos-token-cipher.ts` — its shape; it may be
   removed once #787 merges, so treat it as a *pattern*, not a dependency). The
   script must: read both `AI_TOKEN_ENCRYPTION_KEY` (old) and
   `AI_TOKEN_ENCRYPTION_KEY_NEXT` (new) from env; for every `*Cipher` value on
   `clover_merchants` / `pos_accounts` / `kds_provider_configs`, **decrypt with old →
   re-encrypt with new → write back**; support `--dry-run` (count only) and be
   idempotent (skip a row already decryptable by the new key). The env-key
   `encryptSecret` / `decryptSecret` helpers only know the *single* key, so build
   the envelope with explicit keys via the `createCipheriv` / `createDecipheriv`
   construction in `encryption.ts`.
4. **Open a window** (off-hours / store closed) and stop the readers so nothing
   serves a half-rotated table:
   `ssh oracle 'cd /home/ubuntu/restaurant-ops-platform && docker compose -f compose/kds.yml stop kds-api kds-worker'`
5. **Dry-run, then the real run** — from a one-off container off the kds-api image,
   **wrapped in `with-infisical`** (a bare `docker exec`/`docker run` does **not**
   see the Infisical-injected keys; only the `with-infisical` entrypoint fetches
   them using the machine identity in the host env):
   ```bash
   ssh oracle 'cd /home/ubuntu/restaurant-ops-platform && \
     docker compose -f compose/kds.yml run --rm --no-deps --entrypoint with-infisical \
       kds-api node dist/scripts/<reencrypt>.js --dry-run'
   # then the same without --dry-run
   ```
   Confirm it reports **0 rows still decryptable only by the old key**.
6. **Swap in Infisical:** set `AI_TOKEN_ENCRYPTION_KEY` = the new value, then delete
   `AI_TOKEN_ENCRYPTION_KEY_NEXT`.
7. **Restart:** `docker compose -f compose/kds.yml up -d kds-api kds-worker`.
   `with-infisical` injects the new key; the #772 boot guard
   (`assertAiTokenEncryptionKey`) asserts it's present and 64-hex, so a missed
   swap fails fast and loud instead of crash-looping.
8. **Verify decryptability:** `/api/health` green, then exercise one read path
   (trigger a Clover/Square sync) and confirm tokens decrypt — watch Loki for GCM
   `Unsupported state or unable to authenticate data` errors (= a row the new key
   can't read; you missed it in step 5 — restore from the step-0 backup and redo).
9. **Retire the old key** from the 1Password break-glass entry once verified.

## Variant B — zero-downtime (after P3-1)

Once `encryption.ts` gains an `AI_TOKEN_ENCRYPTION_KEY_PREVIOUS` decrypt-fallback
(audit P3-1, mirroring the `APP_SETTING_ENCRYPTION_KEY` dual-key pattern): set
old → `_PREVIOUS`, new → primary, restart (reads fall back to old, writes use
new), re-encrypt the rows in the background, then drop `_PREVIOUS` on the next
restart. No window. This is the same shape already documented for
`APP_SETTING_ENCRYPTION_KEY` in [OPERATIONS.md §7.2](../../OPERATIONS.md#72-rotation-procedures) — don't duplicate it here.

## Not this key

`APP_SETTING_ENCRYPTION_KEY` (backoffice `app_setting` rows) **already** rotates
with a built-in dual-key fallback — do not use this runbook for it. Follow its row
in [OPERATIONS.md §7.2](../../OPERATIONS.md#72-rotation-procedures) (re-save every
`category=secret` row at `/settings/ai`).
