import { type WebAdminRole } from "@rop/contracts";
import type { PrismaClient, WebAdminAccount } from "@rop/db-auth";
import type { AuthServiceConfig } from "./config.js";
import type { AuthRedis } from "./redis.js";
import { getFlowCookieOptions, getSessionCookieOptions } from "./cookie.js";
import {
  createSession as createAuthSession,
  destroySession as destroyAuthSession,
  readSession as readAuthSession
} from "./session.js";
import {
  clearPasskeyAttempts,
  clearPasswordAttempts,
  getPasskeyRateLimit,
  getPasswordRateLimit,
  registerFailedPasskeyAttempt,
  registerFailedPasswordAttempt
} from "./rate-limit.js";
import {
  bootstrapAdminAccount,
  ensureTenantMembership,
  getAccountById,
  getAdminAccountByUsername,
  resolveAccountTenantId,
  verifyAdminPassword
} from "./user.js";
import {
  consumeWebAuthnFlow,
  createWebAuthnFlow
} from "./webauthn.js";
import {
  deletePasskey,
  findCredentialByCredentialId,
  getPasskeyCount,
  listPasskeys,
  savePasskeyCredential,
  toWebAuthnCredential,
  updateCredentialUsage
} from "./passkey.js";
import {
  changeAccountPassword as changeAccountPasswordFn,
  setPasswordWithToken as setPasswordWithTokenFn
} from "./password-account.js";
import {
  countUsableLoginMethods as countUsableLoginMethodsFn,
  deletePasskeyGuarded as deletePasskeyGuardedFn,
  wouldLeaveNoLoginMethod
} from "./lockout.js";
import {
  createPasswordSetupToken as createPasswordSetupTokenFn,
  type PasswordSetupPurpose
} from "./password-setup.js";

type SessionAccount = Pick<WebAdminAccount, "id" | "username" | "displayName" | "role">;

export function createWebAuthService(prisma: PrismaClient, redis: AuthRedis, config: AuthServiceConfig) {
  const sessionTtlSeconds = config.webSessionTtlHours * 60 * 60;

  return {
    bootstrapAdminAccount: () => bootstrapAdminAccount(prisma, config),
    // Multi-tenant (ADR-0818 / #902 Phase 0): idempotently bind an account to a
    // tenant. kds-api's provisionTenant saga calls this through the service so it
    // never imports db-auth directly (Iron Law 3).
    ensureTenantMembership: (input: { accountId: string; tenantId: string; role?: WebAdminRole }) =>
      ensureTenantMembership(prisma, input),
    getAdminAccountByUsername: (username: string) => getAdminAccountByUsername(prisma, username),
    getAccountById: (accountId: string) => getAccountById(prisma, accountId),
    verifyPassword: (username: string, password: string) => verifyAdminPassword(prisma, username, password),
    // Multi-tenant Phase 2 (ADR-0818): resolve the account's tenant from its
    // membership and stamp it into the session. Covers every mint site (kds-api
    // + backoffice password/passkey login) since they all call this binding.
    createSession: async (account: SessionAccount) => {
      const tenantId = await resolveAccountTenantId(prisma, account.id);
      return createAuthSession(redis, sessionTtlSeconds, account, tenantId);
    },
    readSession: (sessionId: string | undefined) => readAuthSession(redis, sessionTtlSeconds, sessionId),
    destroySession: (sessionId: string | undefined) => destroyAuthSession(redis, sessionId),
    createWebAuthnFlow: (state: Parameters<typeof createWebAuthnFlow>[2]) => createWebAuthnFlow(redis, config, state),
    consumeWebAuthnFlow: (flowId: string | undefined) => consumeWebAuthnFlow(redis, flowId),
    getPasswordRateLimit: (ip: string, username: string) => getPasswordRateLimit(redis, ip, username),
    registerFailedPasswordAttempt: (ip: string, username: string) => registerFailedPasswordAttempt(redis, ip, username),
    clearPasswordAttempts: (ip: string, username: string) => clearPasswordAttempts(redis, ip, username),
    getPasskeyRateLimit: (ip: string) => getPasskeyRateLimit(redis, ip),
    registerFailedPasskeyAttempt: (ip: string) => registerFailedPasskeyAttempt(redis, ip),
    clearPasskeyAttempts: (ip: string) => clearPasskeyAttempts(redis, ip),
    getPasskeyCount: (accountId: string) => getPasskeyCount(prisma, accountId),
    listPasskeys: (accountId: string) => listPasskeys(prisma, accountId),
    savePasskeyCredential: (input: Parameters<typeof savePasskeyCredential>[1]) => savePasskeyCredential(prisma, input),
    deletePasskey: (accountId: string, credentialId: string) => deletePasskey(prisma, accountId, credentialId),
    findCredentialByCredentialId: (credentialId: string) => findCredentialByCredentialId(prisma, credentialId),
    updateCredentialUsage: (credentialId: string, input: Parameters<typeof updateCredentialUsage>[2]) =>
      updateCredentialUsage(prisma, credentialId, input),
    getSessionCookieOptions: () => getSessionCookieOptions(config, sessionTtlSeconds),
    getFlowCookieOptions: () => getFlowCookieOptions(config),
    changePassword: (input: { accountId: string; currentPassword: string; newPassword: string }) =>
      changeAccountPasswordFn(prisma, input),
    setPasswordWithToken: (input: { token: string; newPassword: string }) =>
      setPasswordWithTokenFn(prisma, redis, input),
    createPasswordSetupToken: (accountId: string, purpose: PasswordSetupPurpose) =>
      createPasswordSetupTokenFn(redis, accountId, purpose),
    countUsableLoginMethods: (accountId: string) => countUsableLoginMethodsFn(prisma, accountId),
    wouldLeaveNoLoginMethod,
    deletePasskeyGuarded: (accountId: string, credentialId: string) =>
      deletePasskeyGuardedFn(prisma, accountId, credentialId),
    toWebAuthnCredential
  };
}

export type WebAuthService = ReturnType<typeof createWebAuthService>;
