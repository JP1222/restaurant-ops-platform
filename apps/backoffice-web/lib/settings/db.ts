import { createPrismaClient, type AppSetting, type PrismaClient } from "@rop/db-kds";
import { getCategory, getTier } from "@rop/contracts";
import {
  errorMessage,
  logErrorEvent,
  logSettingChangeEvent,
} from "@/lib/ai/log";
import { SettingDecryptError, decryptSecret, encryptSecret } from "./crypto";
import { BRAND_SCOPE_ID } from "./tenancy";

/**
 * Thrown by `upsertSetting` when the caller's `ifVersion` does not match the
 * row's current version (issue #177): another writer updated the key since the
 * client read it. The route maps this to a 409 `conflict` and returns
 * `currentVersion` + `currentValue` so the UI can offer "reload, then re-apply".
 * `currentValue` is the JSON-encoded stored string AFTER any secret decryption
 * (so the route can hand the plaintext-or-config value straight back) — for
 * secret keys we never put plaintext in the body, so the route strips it.
 */
export class SettingVersionConflictError extends Error {
  readonly currentVersion: number;
  readonly currentValue: string | null;
  constructor(currentVersion: number, currentValue: string | null) {
    super("setting_version_conflict");
    this.name = "SettingVersionConflictError";
    this.currentVersion = currentVersion;
    this.currentValue = currentValue;
  }
}

// db-kds client shared across the db-kds consumers (settings, ai, location) on
// a dedicated global so it never collides with the db-AUTH client that
// `lib/auth/service.ts` stores on `__ropBackofficeAuth.prisma` — the two
// schemas are disjoint (db-auth has no AppSetting model, so reusing that slot
// after login made `.appSetting` undefined). ADR-0016 carve-out.
type KdsGlobals = {
  prisma?: PrismaClient;
};

function getPrisma(): PrismaClient {
  const globals = globalThis as typeof globalThis & {
    __ropBackofficeKds?: KdsGlobals;
  };
  globals.__ropBackofficeKds ??= {};
  globals.__ropBackofficeKds.prisma ??= createPrismaClient();
  return globals.__ropBackofficeKds.prisma;
}

/**
 * Read-path branch on `category=secret`. Rows whose `value` we cannot
 * decrypt are emitted as a `null` value (rather than a row-level throw) so a
 * single broken row doesn't take down the whole `/api/settings` GET. The
 * structured log names the key + envelope version but NEVER the key material
 * or ciphertext content — operators correlate by key name.
 */
function decryptIfSecret(row: AppSetting): AppSetting {
  if (getCategory(row.key) !== "secret") return row;
  try {
    // The envelope holds the JSON-encoded setting value — the write path stores
    // `encryptSecret(JSON.stringify(value))` — so decryptSecret already returns
    // that JSON string, the SAME shape a non-secret row's `value` column holds.
    // Return it as-is. Re-stringifying here double-encodes: a `"sk-..."` key
    // reads back as `"\"sk-...\""`, so the reveal endpoint + provider (which each
    // JSON.parse once) get the key with literal surrounding quotes and DeepSeek
    // 401s on it. (Never exercised until the first real key was set — #547-class.)
    const decoded = decryptSecret(row.value);
    return { ...row, value: decoded };
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.lib.settings.decrypt",
      message:
        error instanceof SettingDecryptError
          ? error.message
          : errorMessage(error, "decrypt_failed"),
      context: { key: row.key },
    });
    return { ...row, value: "null" };
  }
}

// `app_setting.merchantId` is a scope id (ADR-0018, multi-location). Brand-tier
// keys share `BRAND_SCOPE_ID`; location-tier keys are scoped by a `Location.id`.
// A location-tier key with no active location resolves to `BRAND_SCOPE_ID` on
// reads (finds no row, so the caller falls back to env/default) and is rejected
// on write. These helpers are the ONLY chokepoint that talks to `appSetting`,
// so the scope seam stays in one place.
function scopeForKey(key: string, activeLocationId?: string): string {
  return getTier(key) === "location" && activeLocationId
    ? activeLocationId
    : BRAND_SCOPE_ID;
}

export async function findAllSettings(activeLocationId?: string): Promise<AppSetting[]> {
  const scopes = activeLocationId ? [BRAND_SCOPE_ID, activeLocationId] : [BRAND_SCOPE_ID];
  const rows = await getPrisma().appSetting.findMany({
    where: { merchantId: { in: scopes } },
  });
  return rows.map(decryptIfSecret);
}

export async function findSetting(
  key: string,
  activeLocationId?: string,
): Promise<AppSetting | null> {
  const row = await getPrisma().appSetting.findUnique({
    where: { merchantId_key: { merchantId: scopeForKey(key, activeLocationId), key } },
  });
  return row ? decryptIfSecret(row) : null;
}

export async function upsertSetting(args: {
  key: string;
  value: string;
  category: string;
  updatedBy: string | null;
  updatedByUsername?: string | null;
  /**
   * Optimistic-concurrency guard (issue #177). When provided and it does not
   * match the row's current `version`, throws `SettingVersionConflictError`
   * instead of writing. Omit for an unconditional write.
   */
  ifVersion?: number;
  activeLocationId?: string;
}): Promise<AppSetting> {
  if (getTier(args.key) === "location" && !args.activeLocationId) {
    throw new Error(`location-tier setting "${args.key}" requires an active location`);
  }
  const scope = scopeForKey(args.key, args.activeLocationId);
  const isSecret = getCategory(args.key) === "secret";
  // `args.value` is the JSON-encoded validated setting value from the route.
  // For secrets, we wrap that string in an AES-GCM envelope (also JSON) and
  // store the envelope. Decrypt path reverses this in `decryptIfSecret`.
  const storedValue = isSecret ? encryptSecret(args.value) : args.value;

  const prisma = getPrisma();
  const existing = await prisma.appSetting.findUnique({
    where: { merchantId_key: { merchantId: scope, key: args.key } },
  });
  const currentVersion = existing?.version ?? 0;

  // The JSON-encoded *plaintext* form of the existing row, in the SAME shape as
  // `args.value` (so the two are directly comparable / interchangeable). For a
  // secret that's the single decrypt of the envelope; for a plain key it's the
  // stored column as-is. Returns null if the row is missing or undecryptable —
  // an undecryptable row is treated as "different", forcing a fresh write.
  const decodedExisting: string | null = (() => {
    if (!existing) return null;
    if (!isSecret) return existing.value;
    try {
      return decryptSecret(existing.value);
    } catch {
      return null;
    }
  })();

  // Last-write-wins detection (issue #177): the client tells us the version it
  // last read; if the row has moved on, reject so the caller can reload. We
  // hand back the current value (already JSON-encoded, same shape the read path
  // yields) so the route can show what's live; the route strips it for secrets.
  if (args.ifVersion !== undefined && args.ifVersion !== currentVersion) {
    throw new SettingVersionConflictError(currentVersion, decodedExisting);
  }

  // No-op write (issue #159): the new value equals what's already persisted ->
  // don't bump the version and don't append an audit row. Comparing the decoded
  // plaintext (not the ciphertext) makes this correct for secrets too, whose
  // envelope is re-randomized on every encrypt.
  if (existing) {
    const sameValue = decodedExisting === args.value;
    if (sameValue) {
      // Still refresh updatedBy/updatedAt so "who touched this last" stays
      // accurate, but leave version + audit untouched (this is not a change).
      return prisma.appSetting.update({
        where: { merchantId_key: { merchantId: scope, key: args.key } },
        data: { category: args.category, updatedBy: args.updatedBy },
      });
    }
  }

  const nextVersion = currentVersion + 1;
  // Audit value capture (issue #159): for secret keys we MUST NOT persist
  // plaintext key material in the audit log either. Store a stable redaction
  // marker so the trail records THAT the secret changed, never its value.
  const REDACTED = "[redacted-secret]";
  const auditOld = existing
    ? isSecret
      ? REDACTED
      : existing.value
    : null;
  const auditNew = isSecret ? REDACTED : storedValue;

  // Structured stdout log (issue #159): mirror the change into Loki so it shows
  // up in log aggregation EVEN IF the DB audit write fails. Emitted before the
  // transaction so a DB outage can't swallow the trail. Never logs secret
  // plaintext — `valueRedacted` gates the value fields.
  logSettingChangeEvent({
    key: args.key,
    merchantId: scope,
    changedBy: args.updatedBy,
    changedByUsername: args.updatedByUsername ?? null,
    fromVersion: currentVersion,
    toVersion: nextVersion,
    valueRedacted: isSecret,
    oldValue: isSecret ? null : existing?.value ?? null,
    newValue: isSecret ? null : storedValue,
  });

  // Transactional write (issue #159): upsert the value and append exactly one
  // audit row atomically, so the live value and its trail can never diverge.
  const [row] = await prisma.$transaction([
    prisma.appSetting.upsert({
      where: { merchantId_key: { merchantId: scope, key: args.key } },
      create: {
        merchantId: scope,
        key: args.key,
        value: storedValue,
        category: args.category,
        version: nextVersion,
        updatedBy: args.updatedBy,
      },
      update: {
        value: storedValue,
        category: args.category,
        version: nextVersion,
        updatedBy: args.updatedBy,
      },
    }),
    prisma.appSettingAudit.create({
      data: {
        merchantId: scope,
        key: args.key,
        oldValue: auditOld,
        newValue: auditNew,
        changedBy: args.updatedBy,
        changedByUsername: args.updatedByUsername ?? null,
      },
    }),
  ]);

  return row;
}
