import type { KitchenBoardSettings } from "@rop/contracts";
import { OrderProvider, type KdsProviderConfig } from "@rop/db-kds";
import type { AppServices } from "./services.js";
import {
  buildDeliverectProviderUpsert,
  defaultBoardSettings,
  serializeBoardSettings,
  serializeStoredBoardSettings
} from "./board-settings.js";

/**
 * Caller-role tier for board-settings writes (Phase 4.5.4 Iron Law #4 gating).
 *
 * - "admin": Backoffice/internal-bearer caller (kds-api admin routes). All
 *   fields accepted.
 * - "floor": kds-web Floor surface (no auth at the kds-api boundary today —
 *   the route is open and identified solely by which endpoint was hit).
 *   Operator-config and Deliverect-secret fields are silently dropped from
 *   the persisted body; the rest of the Floor's per-screen runtime prefs
 *   (filter, display non-weather, modifier visibility) still round-trip.
 */
export type BoardSettingsWriteRole = "admin" | "floor";

function filterUpsertPayload(body: KitchenBoardSettings) {
  return {
    allowedOrderTypes: body.filter.allowedOrderTypes,
    blockedSources: body.filter.blockedSources,
    paymentStates: body.filter.paymentStates,
    createdAfterMinutes: body.filter.createdAfterMinutes,
    searchText: body.filter.searchText,
    includeCompleted: body.filter.includeCompleted,
    soundEnabled: body.filter.soundEnabled,
    screenPinEnabled: body.filter.screenPinEnabled
  };
}

/**
 * Returns a copy of `body` with operator-config and Deliverect-secret fields
 * forced back to either the persisted-defaults or the existing-on-disk value
 * so a Floor-session write cannot promote a malicious or stale value into
 * the database. The merge prefers the existing persisted settings (so the
 * Floor sees the same operator-config it already had) and falls back to
 * environment defaults when nothing has been persisted yet.
 */
function stripOperatorConfigForFloor(
  body: KitchenBoardSettings,
  existing: KitchenBoardSettings
): KitchenBoardSettings {
  return {
    ...body,
    boardTimeZone: existing.boardTimeZone,
    dailyResetEnabled: existing.dailyResetEnabled,
    dailyResetTime: existing.dailyResetTime,
    reconcileIntervalSeconds: existing.reconcileIntervalSeconds,
    urgencyWarningMinutes: existing.urgencyWarningMinutes,
    urgencyCriticalMinutes: existing.urgencyCriticalMinutes,
    urgencyBlinkCritical: existing.urgencyBlinkCritical,
    display: existing.display,
    // Deliverect: the Floor never gets the real secret in the GET response
    // (Phase 4.5.3 in Cluster 2 enforces this on the read path). Even so,
    // we defend in depth here: the Floor cannot write the apiToken /
    // hmacSecret fields, or any provider-level metadata (enabled,
    // environment, location IDs, channel link), back to the database.
    providers: existing.providers
  };
}

export async function loadBoardSettings(
  services: AppServices,
  merchantId: string
): Promise<KitchenBoardSettings> {
  const [filter, provider] = await Promise.all([
    services.prisma.kdsFilter.findUnique({ where: { merchantId } }),
    services.prisma.kdsProviderConfig.findUnique({
      where: {
        merchantId_provider: {
          merchantId,
          provider: OrderProvider.DELIVERECT
        }
      }
    })
  ]);

  return serializeBoardSettings(filter, provider, services.config);
}

export async function saveBoardSettings(
  services: AppServices,
  merchantId: string,
  body: KitchenBoardSettings,
  role: BoardSettingsWriteRole = "admin"
): Promise<KitchenBoardSettings> {
  const effectiveBody =
    role === "floor"
      ? stripOperatorConfigForFloor(
          body,
          (await loadBoardSettings(services, merchantId)) ?? defaultBoardSettings(services.config)
        )
      : body;

  const filterPayload = filterUpsertPayload(effectiveBody);
  const storedBoardSettings = serializeStoredBoardSettings(effectiveBody);

  const [savedFilter, savedProvider] = await services.prisma.$transaction(async (tx) => {
    const filter = await tx.kdsFilter.upsert({
      where: { merchantId },
      update: {
        ...filterPayload,
        boardSettings: storedBoardSettings
      },
      create: {
        merchantId,
        ...filterPayload,
        boardSettings: storedBoardSettings
      }
    });

    // Admin tier: kds-api still owns the Deliverect upsert because legacy
    // tests + ops callers may PUT a full KitchenBoardSettings through
    // /api/admin/kds/board-settings. The dedicated
    // /api/admin/kds/integrations/deliverect endpoint added in Step 4.5.2 is
    // the editor-facing path that writes ciphers; this admin-tier path
    // keeps the legacy plaintext write semantics for backwards compatibility
    // during the rollout window.
    //
    // Floor tier: we skip the Deliverect upsert entirely so a Floor PUT
    // cannot touch the provider row at all (even with stripped fields).
    let provider: KdsProviderConfig | null;
    if (role === "admin") {
      const providerPayload = buildDeliverectProviderUpsert(effectiveBody);
      provider = await tx.kdsProviderConfig.upsert({
        where: {
          merchantId_provider: {
            merchantId,
            provider: OrderProvider.DELIVERECT
          }
        },
        update: providerPayload,
        create: {
          merchantId,
          provider: OrderProvider.DELIVERECT,
          ...providerPayload
        }
      });
    } else {
      provider = await tx.kdsProviderConfig.findUnique({
        where: {
          merchantId_provider: {
            merchantId,
            provider: OrderProvider.DELIVERECT
          }
        }
      });
    }

    return [filter, provider] as const;
  });

  return serializeBoardSettings(savedFilter, savedProvider, services.config);
}
