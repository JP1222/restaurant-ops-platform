import { Redis } from "ioredis";
import { createPrismaClient, type PrismaClient } from "@rop/db-auth";
import { createWebAuthService } from "@rop/auth/server";
import { getBackofficeAuthConfig, getRedisUrl } from "./config";

type BackofficeAuthGlobals = {
  prisma?: PrismaClient;
  redis?: Redis;
};

const globals = globalThis as typeof globalThis & {
  __ropBackofficeAuth?: BackofficeAuthGlobals;
};

function getGlobals() {
  globals.__ropBackofficeAuth ??= {};
  return globals.__ropBackofficeAuth;
}

function getBackofficeAuthPrisma() {
  const cache = getGlobals();
  cache.prisma ??= createPrismaClient();
  return cache.prisma;
}

export function getBackofficeAuthService() {
  const cache = getGlobals();

  cache.prisma ??= createPrismaClient();
  cache.redis ??= new Redis(getRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 2
  });

  return createWebAuthService(cache.prisma, cache.redis, getBackofficeAuthConfig());
}

// Profile self-edit (displayName) is the one db-auth WRITE that has no
// dedicated helper on the shared service yet. Keeping it inside lib/auth/**
// (the auth-boundary carve-out, Iron Law #3) lets the BFF route stay free of
// any @rop/db-auth import. Self-scoped: caller passes the session
// account id derived from the cookie, never the body.
export async function updateSelfDisplayName(accountId: string, displayName: string) {
  return getBackofficeAuthPrisma().webAdminAccount.update({
    where: { id: accountId },
    data: { displayName },
    select: { id: true, username: true, displayName: true, role: true }
  });
}
