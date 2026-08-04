import { OrderProvider, type Prisma, type PrismaClient } from "@rop/db-kds";
import type { AppConfig } from "../config.js";
import { resolveCloverEnvironment } from "./clover-admin.js";

type UpsertStateInput = {
  latestWebhookVerificationCode?: string | null;
  latestWebhookVerificationAt?: Date | null;
  lastSignedWebhookAt?: Date | null;
  tokenModeMerchantId?: string | null;
};

type ProviderStateClient = PrismaClient | Prisma.TransactionClient;

export function cloverProviderStateWhere(config: AppConfig) {
  return {
    provider_environment: {
      provider: OrderProvider.CLOVER,
      environment: resolveCloverEnvironment(config)
    }
  };
}

export async function upsertCloverProviderState(
  prisma: ProviderStateClient,
  config: AppConfig,
  data: UpsertStateInput
) {
  const environment = resolveCloverEnvironment(config);
  const update: Prisma.ProviderAppStateUpdateInput = {};

  if (data.latestWebhookVerificationCode !== undefined) {
    update.latestWebhookVerificationCode = data.latestWebhookVerificationCode;
  }
  if (data.latestWebhookVerificationAt !== undefined) {
    update.latestWebhookVerificationAt = data.latestWebhookVerificationAt;
  }
  if (data.lastSignedWebhookAt !== undefined) {
    update.lastSignedWebhookAt = data.lastSignedWebhookAt;
  }
  if (data.tokenModeMerchantId !== undefined) {
    update.tokenModeMerchantId = data.tokenModeMerchantId;
  }

  return prisma.providerAppState.upsert({
    where: {
      provider_environment: {
        provider: OrderProvider.CLOVER,
        environment
      }
    },
    update,
    create: {
      provider: OrderProvider.CLOVER,
      environment,
      latestWebhookVerificationCode: data.latestWebhookVerificationCode ?? null,
      latestWebhookVerificationAt: data.latestWebhookVerificationAt ?? null,
      lastSignedWebhookAt: data.lastSignedWebhookAt ?? null,
      tokenModeMerchantId: data.tokenModeMerchantId ?? null
    }
  });
}
