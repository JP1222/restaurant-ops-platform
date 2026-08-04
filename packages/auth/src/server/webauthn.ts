import { randomBytes } from "node:crypto";
import { parseJson } from "./json.js";
import type { AuthServiceConfig } from "./config.js";
import { WEBAUTHN_FLOW_TTL_SECONDS } from "./cookie.js";
import type { AuthRedis } from "./redis.js";

const WEBAUTHN_FLOW_KEY_PREFIX = "auth:webauthn:";

export type WebAuthnFlowType = "registration" | "authentication";

type WebAuthnFlowRecord = {
  challenge: string;
  flowType: WebAuthnFlowType;
  accountId: string | null;
  expectedOrigin: string;
  expectedRPID: string;
  issuedAt: string;
};

export type WebAuthnFlowState = {
  challenge: string;
  flowType: WebAuthnFlowType;
  accountId: string | null;
  expectedOrigin: string;
  expectedRPID: string;
  issuedAt: string;
};

function flowKey(flowId: string) {
  return `${WEBAUTHN_FLOW_KEY_PREFIX}${flowId}`;
}

export function getExpectedWebAuthnOrigin(config: AuthServiceConfig) {
  return new URL(config.appBaseUrl).origin;
}

export function getWebAuthnRpId(config: AuthServiceConfig) {
  return config.webauthnRpId ?? new URL(config.appBaseUrl).hostname;
}

export function getWebAuthnRpName(config: AuthServiceConfig) {
  return config.webauthnRpName;
}

export async function createWebAuthnFlow(
  redis: AuthRedis,
  config: AuthServiceConfig,
  state: {
    challenge: string;
    flowType: WebAuthnFlowType;
    accountId?: string | null;
  }
) {
  const flowId = randomBytes(18).toString("base64url");
  const record: WebAuthnFlowRecord = {
    challenge: state.challenge,
    flowType: state.flowType,
    accountId: state.accountId ?? null,
    expectedOrigin: getExpectedWebAuthnOrigin(config),
    expectedRPID: getWebAuthnRpId(config),
    issuedAt: new Date().toISOString()
  };

  await redis.set(flowKey(flowId), JSON.stringify(record), "EX", WEBAUTHN_FLOW_TTL_SECONDS);
  return flowId;
}

// GH #477: read-and-delete the single-use challenge atomically so two concurrent
// assertions sharing a flowId can't both observe it before either delete lands
// (a WebAuthn replay window). We prefer a MULTI transaction over the older
// get-then-del: GETDEL would be cleaner but isn't on the `AuthRedis` typing and
// can't be assumed present on the deployed server, whereas MULTI has been
// available for far longer. The challenge value is read from the queued GET's
// result tuple. A non-transactional get/del fallback keeps stub redis clients
// (which don't implement `multi`) working with identical null/parse handling.
async function getAndDeleteRaw(redis: AuthRedis, key: string): Promise<string | null> {
  if (typeof redis.multi !== "function") {
    const raw = await redis.get(key);
    await redis.del(key);
    return raw;
  }

  const results = await redis.multi().get(key).del(key).exec();
  const getResult = results?.[0];
  if (!getResult) {
    return null;
  }

  const [getError, getValue] = getResult;
  if (getError) {
    throw getError;
  }

  return typeof getValue === "string" ? getValue : null;
}

export async function consumeWebAuthnFlow(redis: AuthRedis, flowId: string | undefined) {
  if (!flowId) {
    return null;
  }

  const key = flowKey(flowId);
  const raw = await getAndDeleteRaw(redis, key);
  const parsed = parseJson<WebAuthnFlowRecord>(raw);
  if (!parsed) {
    return null;
  }

  return {
    challenge: parsed.challenge,
    flowType: parsed.flowType,
    accountId: parsed.accountId,
    expectedOrigin: parsed.expectedOrigin,
    expectedRPID: parsed.expectedRPID,
    issuedAt: parsed.issuedAt
  } satisfies WebAuthnFlowState;
}
