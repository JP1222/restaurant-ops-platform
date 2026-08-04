import type { AppConfig } from "../config.js";
import { cloverProviderStateWhere } from "./provider-app-state.js";

type MerchantRecord = {
  id: string;
  refreshTokenCipher?: Uint8Array | null;
  refreshTokenExpiresAt?: Date | null;
  recoveryTokenCipher?: Uint8Array | null;
  appInstalledAt?: Date | null;
};

function hasBytes(value: Uint8Array | null | undefined): boolean {
  return Boolean(value && value.byteLength > 0);
}

export type CloverMerchantLookup = {
  cloverMerchant: {
    findUnique(args: {
      where: { id: string };
      select: { id: true };
    }): Promise<MerchantRecord | null>;
    findFirst(args: {
      select: { id: true };
      orderBy: { updatedAt: "desc" };
    }): Promise<MerchantRecord | null>;
  };
  providerAppState: {
    findUnique(args: {
      where: ReturnType<typeof cloverProviderStateWhere>;
      select: { tokenModeMerchantId: true };
    }): Promise<{ tokenModeMerchantId: string | null } | null>;
  };
};

export function canBootstrapCloverMerchantFromEnv(config: AppConfig) {
  return Boolean(config.cloverMerchantId && config.cloverToken);
}

export function getConfiguredCloverMerchantId(config: AppConfig) {
  return canBootstrapCloverMerchantFromEnv(config) ? config.cloverMerchantId : undefined;
}

export function getConfiguredCloverToken(config: AppConfig) {
  return canBootstrapCloverMerchantFromEnv(config) ? config.cloverToken : undefined;
}

export async function resolveDefaultCloverMerchantId(
  prisma: CloverMerchantLookup,
  config: AppConfig,
  requested: string | undefined
) {
  if (requested) {
    return requested;
  }

  const providerState = await prisma.providerAppState.findUnique({
    where: cloverProviderStateWhere(config),
    select: { tokenModeMerchantId: true }
  });
  if (providerState?.tokenModeMerchantId) {
    const merchant = await prisma.cloverMerchant.findUnique({
      where: { id: providerState.tokenModeMerchantId },
      select: { id: true }
    });
    if (merchant) {
      return merchant.id;
    }
  }

  const configuredMerchantId = getConfiguredCloverMerchantId(config);
  if (configuredMerchantId) {
    return configuredMerchantId;
  }

  const merchant = await prisma.cloverMerchant.findFirst({
    select: { id: true },
    orderBy: { updatedAt: "desc" }
  });

  return merchant?.id ?? null;
}

export function isOauthConnectedCloverMerchant(merchant: MerchantRecord | null | undefined) {
  if (!merchant) {
    return false;
  }

  // Cipher-only: the refresh/recovery secrets live solely in the *Cipher columns
  // (the plaintext columns were dropped in 20260618_drop_pos_token_plaintext), so
  // "is OAuth-connected" keys on the cipher presence plus the non-secret markers.
  return Boolean(
    merchant.appInstalledAt ||
    hasBytes(merchant.refreshTokenCipher) ||
    merchant.refreshTokenExpiresAt ||
    hasBytes(merchant.recoveryTokenCipher)
  );
}

export function isLegacyCloverTokenRecord(merchant: MerchantRecord | null | undefined) {
  return Boolean(merchant) && !isOauthConnectedCloverMerchant(merchant);
}
