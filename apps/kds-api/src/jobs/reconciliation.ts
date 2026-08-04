import { OrderProvider } from "@rop/db-kds";

import type { AppServices } from "../lib/services.js";
import { RECONCILE_INTERVAL_MIN_SECONDS, resolveReconcileIntervalMs } from "../lib/board-settings.js";
import { resolveSquareStoreCredentials } from "../lib/square-menu.js";
import type { SquareOrder } from "../domain/normalize-square-order.js";

type OrdersResponse = {
  elements?: Array<{
    id?: string;
  }>;
};

export async function runReconciliationOnce(services: AppServices) {
  // Every per-store row lives in clover_merchants (Clover merchants AND the
  // `square:{loc}` PosStores). Load each row's provider so a Square store is
  // polled via Square's SearchOrders, NOT Clover's fetchModifiedOrders (which
  // would 502 on a square: id). A legacy row with no PosAccount is Clover.
  const merchants = await services.prisma.cloverMerchant.findMany({
    where: {
      authStatus: "ACTIVE"
    },
    include: { posAccount: { select: { provider: true } } }
  });

  if (merchants.length === 0) {
    return;
  }

  // The scheduler ticks at a fixed floor (RECONCILE_TICK_MS); each merchant's
  // own poll cadence lives in its board settings, so load them once and gate
  // per merchant. Read every tick → a Backoffice change takes effect without a
  // kds-api restart.
  const filters = await services.prisma.kdsFilter.findMany({
    where: { merchantId: { in: merchants.map((merchant) => merchant.id) } },
    select: { merchantId: true, boardSettings: true }
  });
  const filterByMerchant = new Map(filters.map((filter) => [filter.merchantId, filter]));

  // Allow a run up to half the floor early so tick jitter + run duration don't
  // stretch an N-second cadence out toward ~2N.
  const toleranceMs = RECONCILE_INTERVAL_MIN_SECONDS * 500;
  const tickAt = Date.now();

  for (const merchant of merchants) {
    const intervalMs = resolveReconcileIntervalMs(filterByMerchant.get(merchant.id) ?? null, services.config);
    if (merchant.lastReconciledAt && tickAt - merchant.lastReconciledAt.getTime() < intervalMs - toleranceMs) {
      continue;
    }

    const windowStart = merchant.lastReconciledAt ?? new Date(Date.now() - 5 * 60_000);
    const provider = merchant.posAccount?.provider ?? OrderProvider.CLOVER;
    try {
      if (provider === OrderProvider.SQUARE) {
        await pollSquareStore(services, merchant.id, windowStart);
      } else {
        await pollCloverMerchant(services, merchant.id, windowStart);
      }

      await services.prisma.cloverMerchant.update({
        where: { id: merchant.id },
        data: {
          lastReconciledAt: new Date()
        }
      });
    } catch (error) {
      await services.prisma.deadLetterJob.create({
        data: {
          merchantId: merchant.id,
          jobType: "reconciliation",
          reason: error instanceof Error ? error.message : "Unknown reconciliation failure",
          payload: { merchantId: merchant.id, windowStart: windowStart.toISOString(), provider }
        }
      });
    }
  }
}

// Clover: fetch the order ids modified since the window and enqueue a re-fetch
// job per order (unchanged from the original single-provider loop).
async function pollCloverMerchant(services: AppServices, merchantId: string, windowStart: Date) {
  const response = (await services.clover.fetchModifiedOrders(merchantId, windowStart, {
    bucket: "recon"
  })) as OrdersResponse;
  const elements = Array.isArray(response.elements) ? response.elements : [];
  await services.queue.enqueueBulk(
    elements
      .filter((order): order is { id: string } => Boolean(order.id))
      .map((order) => ({
        provider: OrderProvider.CLOVER,
        merchantId,
        sourceOrderId: order.id,
        reason: "reconciliation" as const,
        idempotencyKey: `recon:${merchantId}:${order.id}:${windowStart.getTime()}`
      }))
  );
}

// Square SearchOrders is eventually-consistent: an order can be fetchable by id
// seconds before it appears in search. Polling is Square's ONLY delivery path
// (no webhook backstop yet), so we re-scan a window OVERLAP behind
// lastReconciledAt — wider than the observed indexing lag — or a late-indexed
// order whose updated_at predates the advanced window would be MISSED forever.
// Re-scans are harmless: the ticket upsert (merchantId, provider, sourceOrderId)
// dedups, and the per-order updated_at idempotency key dedups the enqueue of an
// unchanged order across overlapping polls.
const SQUARE_SEARCH_OVERLAP_MS = 120_000;

// Square: list the location's orders updated since (window − overlap), filtered +
// sorted on UPDATED_AT, and enqueue a re-fetch job per order. `posStoreId` is the
// `square:{location_id}` row id; the credential + bound location come from its
// PosAccount.
async function pollSquareStore(services: AppServices, posStoreId: string, windowStart: Date) {
  const { token, environment, locationId } = await resolveSquareStoreCredentials(services.prisma, posStoreId);
  const searchSince = new Date(windowStart.getTime() - SQUARE_SEARCH_OVERLAP_MS).toISOString();
  const orders = await services.square.searchOrders(token, environment, locationId, searchSince);
  await services.queue.enqueueBulk(
    orders
      .filter((order): order is SquareOrder & { id: string } => Boolean(order.id))
      .map((order) => ({
        provider: OrderProvider.SQUARE,
        merchantId: posStoreId,
        sourceOrderId: order.id,
        reason: "reconciliation" as const,
        // Key on the order's own updated_at (not the poll window) so an unchanged
        // order re-seen across overlapping polls dedups instead of re-enqueuing.
        idempotencyKey: `recon:${posStoreId}:${order.id}:${order.updatedAt ?? ""}`
      }))
  );
}
