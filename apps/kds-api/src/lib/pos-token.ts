import { type IntegrationEnvironment, OrderProvider, type PrismaClient } from "@rop/db-kds";

import { decryptSecret, encryptSecret, toBytes } from "./crypto/encryption.js";

export interface ResolvedPosToken {
  token: string;
  provider: OrderProvider;
  // The PosAccount's environment (STAGING/PRODUCTION); null for a Clover row
  // whose token lives on its own clover_merchants row (Clover never uses a
  // PosAccount — see resolvePosAccessToken).
  environment: IntegrationEnvironment | null;
}

// ---------------------------------------------------------------------------
// At-rest encryption (migrations 20260617_pos_token_cipher +
// 20260618_pos_token_refresh_recovery_cipher; the legacy plaintext columns were
// dropped in 20260618_drop_pos_token_plaintext).
//
// POS OAuth secrets (access / refresh / recovery tokens) are AES-256-GCM
// encrypted in the `*Cipher` BYTEA columns and read CIPHER-ONLY. The dual-read
// plaintext fallback was retired after the prod backfill proved zero plaintext
// rows remained (P1-6 of the 2026-06-18 secret-management audit). Encrypting
// writes populate the cipher; a non-secret (an empty value or a `:webhook`
// sentinel) writes a NULL cipher so a webhook-only row holds no token at all.
//
// This mirrors the Deliverect `apiTokenCipher` precedent (board-settings.ts /
// routes/admin.ts) and reuses the same encryptSecret/decryptSecret primitives,
// so one key — AI_TOKEN_ENCRYPTION_KEY — protects every encrypted token in
// db-kds (the backoffice app_setting store uses its own APP_SETTING_ENCRYPTION_KEY).
// ---------------------------------------------------------------------------

/** Prisma surfaces a `Bytes?` column as `Uint8Array | null`. */
type CipherBytes = Uint8Array | null | undefined;

/**
 * A token value that must NOT be encrypted: an empty string, or a non-API
 * sentinel like `deliverect:webhook` (ADR-0019) used to tag webhook-only
 * providers that never hold a real OAuth token. `encryptSecretForStorage`
 * returns a null cipher for these; its inline guard mirrors this predicate so
 * the two never disagree.
 */
export function isNonSecretToken(value: string | null | undefined): boolean {
  return !value || value.endsWith(":webhook");
}

/**
 * Decrypt one secret cipher column. Returns null when the column is empty — a
 * webhook-only row (Deliverect) or a Square PosStore row legitimately holds no
 * cipher (the credential lives on its linked PosAccount).
 */
export function decodeStoredSecret(cipher: CipherBytes): string | null {
  if (cipher && cipher.byteLength > 0) {
    return decryptSecret(Buffer.from(cipher));
  }
  return null;
}

/**
 * Truthiness for a secret cipher column. Use this anywhere the old code asked
 * `Boolean(row.refreshToken)` — the secret now lives only in the cipher column.
 */
export function hasStoredSecret(cipher: CipherBytes): boolean {
  return Boolean(cipher && cipher.byteLength > 0);
}

/**
 * Encrypt one secret for storage in its `*Cipher` column. A real secret returns
 * the AES-256-GCM cipher bytes; a non-secret (an empty/null value or a
 * `:webhook` sentinel, ADR-0019) returns null so the cipher column is cleared
 * and a webhook-only row holds no token at all. Assign the result straight to
 * the `*Cipher` field of a Prisma create/update — there is no plaintext column.
 */
export function encryptSecretForStorage(value: string | null | undefined): Uint8Array<ArrayBuffer> | null {
  // Inlined (not `isNonSecretToken`) so TS narrows `value` to a non-empty string
  // for the encrypt call; the two predicates are kept identical by hand.
  if (value === null || value === undefined || value.length === 0 || value.endsWith(":webhook")) {
    return null;
  }
  return toBytes(encryptSecret(value));
}

// Minimal structural shapes so callers can pass a full Prisma row or a select.
interface CloverMerchantSecretCols {
  accessTokenCipher?: CipherBytes;
  refreshTokenCipher?: CipherBytes;
  recoveryTokenCipher?: CipherBytes;
}

interface PosAccountSecretCols {
  accessTokenCipher?: CipherBytes;
  refreshTokenCipher?: CipherBytes;
}

export interface ResolvedCloverMerchantSecrets {
  /** "" when no usable access token (a Square PosStore row, or none set). */
  accessToken: string;
  refreshToken: string | null;
  recoveryToken: string | null;
}

export interface ResolvedPosAccountSecrets {
  accessToken: string;
  refreshToken: string | null;
}

/** Decode every secret on a `clover_merchants` (PosStore) row at once. */
export function resolveCloverMerchantSecrets(row: CloverMerchantSecretCols): ResolvedCloverMerchantSecrets {
  return {
    accessToken: decodeStoredSecret(row.accessTokenCipher) ?? "",
    refreshToken: decodeStoredSecret(row.refreshTokenCipher),
    recoveryToken: decodeStoredSecret(row.recoveryTokenCipher)
  };
}

/** Decode every secret on a `pos_accounts` (credential) row at once. */
export function resolvePosAccountSecrets(row: PosAccountSecretCols): ResolvedPosAccountSecrets {
  return {
    accessToken: decodeStoredSecret(row.accessTokenCipher) ?? "",
    refreshToken: decodeStoredSecret(row.refreshTokenCipher)
  };
}

// Resolve the POS API token for a store, PosAccount-first. This is the canonical
// way to read a store's credential (the #739-review follow-up) — Square sync code
// (Phase 3) MUST call this and never read `cloverMerchant` token columns directly,
// because a Square store's token lives on the linked PosAccount, not on the row.
//
// `posStoreId` is the per-store row id (clover_merchants.id == the "PosStore"):
// the Clover merchantId, or the synthetic `square:{location_id}` for Square.
export async function resolvePosAccessToken(
  prisma: PrismaClient,
  posStoreId: string
): Promise<ResolvedPosToken> {
  const store = await prisma.cloverMerchant.findUnique({
    where: { id: posStoreId },
    include: { posAccount: true }
  });
  if (!store) {
    throw new Error(`PosStore ${posStoreId} not found`);
  }

  // A PosAccount-backed store (e.g. Square): the token lives on the linked
  // PosAccount — decrypt its cipher.
  if (store.posAccount) {
    const token = resolvePosAccountSecrets(store.posAccount).accessToken;
    if (token) {
      return {
        token,
        provider: store.posAccount.provider,
        environment: store.posAccount.environment
      };
    }
  }

  // Clover keeps its token on its OWN clover_merchants row (no PosAccount): the
  // Clover write paths (env bootstrap / OAuth exchange / refresh) encrypt
  // straight into this row's accessTokenCipher. Decrypt it here. Such rows are
  // Clover by construction (a Square store is always created WITH a PosAccount).
  const cloverToken = resolveCloverMerchantSecrets(store).accessToken;
  if (cloverToken) {
    return { token: cloverToken, provider: OrderProvider.CLOVER, environment: null };
  }

  // No PosAccount and no token on the row itself: unusable. This is the guard for
  // a Square PosStore row whose credential is missing, or a Deliverect
  // webhook-only row that never holds a token — REFUSE rather than return "".
  throw new Error(
    `PosStore ${posStoreId} has no usable access token: no linked PosAccount and no token on its own clover_merchants row.`
  );
}
