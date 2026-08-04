import { randomBytes } from "node:crypto";
import { DEFAULT_TENANT_ID } from "@rop/contracts";
import type { WebAdminAccount } from "@rop/db-auth";
import { parseJson } from "./json.js";
import type { AuthRedis } from "./redis.js";

const SESSION_KEY_PREFIX = "auth:session:";

// Multi-tenant Phase 2 (ADR-0818): the session carries the account's tenant —
// the hard trust boundary. It is RESOLVED from TenantMembership at mint time
// (see resolveAccountTenantId / service.ts) and stamped here. ADDITIVE +
// zero-consumer in this step: nothing READS `tenantId` yet (the fail-closed
// resolveKdsMerchantId / analytics signed-claim consumption is the next step),
// so login + every existing reader behave exactly as before. `readSession`
// dual-reads pre-Phase-2 records (no `tenantId`) by healing them to the single
// implicit tenant — safe only in the current single-tenant window; the hard
// cutover to fail-closed lands with the consumption step.
type WebSessionRecord = {
  accountId: string;
  username: string;
  displayName: string;
  role: string;
  tenantId: string;
  issuedAt: string;
  lastSeenAt: string;
};

export type WebSessionView = {
  accountId: string;
  username: string;
  displayName: string;
  role: string;
  tenantId: string;
  issuedAt: string;
  lastSeenAt: string;
};

function sessionKey(sessionId: string) {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function toSessionView(record: WebSessionRecord): WebSessionView {
  return {
    accountId: record.accountId,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    tenantId: record.tenantId,
    issuedAt: record.issuedAt,
    lastSeenAt: record.lastSeenAt
  };
}

function toSessionRecord(
  account: Pick<WebAdminAccount, "id" | "username" | "displayName" | "role">,
  tenantId: string
): WebSessionRecord {
  const now = new Date().toISOString();

  return {
    accountId: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    tenantId,
    issuedAt: now,
    lastSeenAt: now
  };
}

export async function createSession(
  redis: AuthRedis,
  sessionTtlSeconds: number,
  account: Pick<WebAdminAccount, "id" | "username" | "displayName" | "role">,
  tenantId: string
) {
  const sessionId = randomBytes(32).toString("base64url");
  const session = toSessionRecord(account, tenantId);
  await redis.set(sessionKey(sessionId), JSON.stringify(session), "EX", sessionTtlSeconds);
  return {
    sessionId,
    session: toSessionView(session)
  };
}

export async function readSession(redis: AuthRedis, sessionTtlSeconds: number, sessionId: string | undefined) {
  if (!sessionId) {
    return null;
  }

  const raw = await redis.get(sessionKey(sessionId));
  const parsed = parseJson<WebSessionRecord>(raw);
  if (!parsed) {
    return null;
  }

  const nextRecord: WebSessionRecord = {
    ...parsed,
    // Dual-read: sessions minted before Phase 2 have no `tenantId`. Heal them to
    // the single implicit tenant so existing logins are not invalidated on
    // deploy. Safe only while one tenant exists; the consumption step replaces
    // this default with fail-closed handling of an absent claim.
    tenantId: parsed.tenantId ?? DEFAULT_TENANT_ID,
    lastSeenAt: new Date().toISOString()
  };
  await redis.set(sessionKey(sessionId), JSON.stringify(nextRecord), "EX", sessionTtlSeconds);
  return toSessionView(nextRecord);
}

export async function destroySession(redis: AuthRedis, sessionId: string | undefined) {
  if (!sessionId) {
    return;
  }

  await redis.del(sessionKey(sessionId));
}
