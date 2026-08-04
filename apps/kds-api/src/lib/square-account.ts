import { IntegrationEnvironment, MerchantAuthStatus, OrderProvider, type PrismaClient } from "@rop/db-kds";
import type { SquareConnectStore, SquareEnvironment } from "@rop/contracts";

import type { AppConfig } from "../config.js";
import { encryptSecretForStorage } from "./pos-token.js";
import type { SquareClient, SquareConnectionInfo } from "./square-client.js";

// The synthetic PosStore PK for a Square location: `square:` + the location id.
export function squarePosStoreId(locationId: string): string {
  return `square:${locationId}`;
}

// CloverMerchant.id (the PosStore PK) is @db.VarChar(32). Guard before any write
// so a long location id fails closed with a clear error rather than a DB throw.
const POS_STORE_ID_MAX = 32;

export class SquarePersistError extends Error {
  constructor(
    readonly kind: "location_id_too_long",
    readonly detail: string
  ) {
    super(`square persist failed: ${kind}`);
    this.name = "SquarePersistError";
  }
}

function wireToDbEnvironment(environment: SquareEnvironment): IntegrationEnvironment {
  return environment === "production" ? IntegrationEnvironment.PRODUCTION : IntegrationEnvironment.STAGING;
}

// Persist a validated Square connection: ONE PosAccount (the credential) + one
// PosStore (clover_merchants row) per location, in a SINGLE transaction so an
// invalid/partial connect never half-writes (no PosAccount without its stores,
// no orphan stores). Idempotent via upsert. The token lives ONLY on the
// PosAccount; a Square PosStore row holds no token of its own.
export async function persistSquareConnection(
  prisma: PrismaClient,
  info: SquareConnectionInfo,
  token: string,
  environment: SquareEnvironment
): Promise<{ posAccountId: string; stores: SquareConnectStore[] }> {
  // Fail-closed length guard BEFORE opening the transaction.
  for (const loc of info.locations) {
    if (squarePosStoreId(loc.id).length > POS_STORE_ID_MAX) {
      throw new SquarePersistError("location_id_too_long", loc.id);
    }
  }

  const dbEnvironment = wireToDbEnvironment(environment);

  // Encrypt the access token at rest into the cipher column (no plaintext column).
  const accessTokenCipher = encryptSecretForStorage(token);

  return prisma.$transaction(async (tx) => {
    const account = await tx.posAccount.upsert({
      where: {
        provider_providerMerchantId_environment: {
          provider: OrderProvider.SQUARE,
          providerMerchantId: info.merchantId,
          environment: dbEnvironment
        }
      },
      update: { accessTokenCipher, authStatus: MerchantAuthStatus.ACTIVE },
      create: {
        provider: OrderProvider.SQUARE,
        providerMerchantId: info.merchantId,
        environment: dbEnvironment,
        accessTokenCipher,
        authStatus: MerchantAuthStatus.ACTIVE
      }
    });

    const stores: SquareConnectStore[] = [];
    for (const loc of info.locations) {
      const row = await tx.cloverMerchant.upsert({
        where: { id: squarePosStoreId(loc.id) },
        update: {
          posAccountId: account.id,
          providerStoreId: loc.id,
          name: loc.name,
          authStatus: MerchantAuthStatus.ACTIVE
        },
        create: {
          id: squarePosStoreId(loc.id),
          posAccountId: account.id,
          providerStoreId: loc.id,
          name: loc.name,
          // The token lives on the PosAccount; a Square PosStore row holds no
          // token of its own (resolvePosAccessToken reads the linked PosAccount).
          authStatus: MerchantAuthStatus.ACTIVE
        }
      });
      stores.push({
        posStoreId: row.id,
        providerStoreId: loc.id,
        name: loc.name,
        timezone: loc.timezone,
        currency: loc.currency,
        locationId: row.locationId ?? null
      });
    }

    return { posAccountId: account.id, stores };
  });
}

export function canBootstrapSquareAccountFromEnv(config: AppConfig): boolean {
  return Boolean(config.squareAccessToken);
}

// Local/sandbox dev convenience (mirrors Clover's bootstrapMerchantFromEnv): when
// SQUARE_ACCESS_TOKEN is set, discover the merchant + locations from the token and
// persist the PosAccount + PosStore so the local polling loop has a real store
// with no manual connect click. A no-op when the token is unset.
export async function bootstrapSquareAccountFromEnv(
  prisma: PrismaClient,
  config: AppConfig,
  square: SquareClient
): Promise<void> {
  if (!config.squareAccessToken) {
    return;
  }
  const info = await square.validateAndListLocations(config.squareAccessToken, config.squareEnvironment);
  await persistSquareConnection(prisma, info, config.squareAccessToken, config.squareEnvironment);
}
