import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startKdsHttpItContext, type KdsHttpItContext } from "./fixture.js";

/**
 * Money-path invariant: a Clover webhook delivered more than once — Clover
 * retries on a slow ack, or a reconciliation poll overlaps a live push — must
 * NOT create duplicate downstream work (duplicate kitchen tickets / order
 * state). `src/routes/clover.ts` defends this in TWO layers:
 *
 *   L1  clover_webhook_events  @@unique([merchantId, eventId])  + createMany(skipDuplicates)
 *   L2  kds_provider_events.fingerprint  @unique                + createMany(skipDuplicates)
 *
 * L1 keys on the payload's stable `eventId` (GH #129), not the content
 * fingerprint, so a resend whose `modifiedTime` differs (or is null) still
 * collapses instead of slipping through. When the payload carries no eventId,
 * the ingest layer synthesizes one from the fingerprint components, preserving
 * the old behavior for that case.
 *
 * The existing ~117 unit tests mock Prisma, so they can NEVER prove this — only
 * a real Postgres enforcing the unique index can reject the second insert. That
 * is exactly the gap this suite closes (ADR-0026; see docs/TESTING.md).
 */

const MERCHANT_ID = "ITWEBHOOKMERCHANT";

/**
 * Flat single-event payload (`FlatPayloadSchema` in clover-webhooks.ts).
 * Same orderId -> same eventId, so a re-POST of the same orderId must collapse
 * at L1 (merchantId, eventId); a different orderId must NOT.
 */
function cloverWebhookPayload(orderId: string, modifiedTime = 1_700_000_000) {
  return {
    merchantId: MERCHANT_ID,
    eventId: `evt-${orderId}`,
    type: "orders",
    orderId,
    modifiedTime,
  };
}

describe("Clover webhook dedup (integration)", () => {
  let ctx: KdsHttpItContext;

  beforeAll(async () => {
    ctx = await startKdsHttpItContext();
    // The handler ignores events for an UNKNOWN merchant, so seed one. `id` is
    // the only required field now that the plaintext token columns are dropped
    // (the *Cipher columns are all nullable).
    await ctx.services.prisma.cloverMerchant.create({
      data: { id: MERCHANT_ID },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    // Clear the two event tables between cases; the merchant row persists.
    // They are independent children of the merchant (no FK between them), so
    // delete order does not matter.
    await ctx.services.prisma.kdsProviderEvent.deleteMany({ where: { merchantId: MERCHANT_ID } });
    await ctx.services.prisma.cloverWebhookEvent.deleteMany({ where: { merchantId: MERCHANT_ID } });
  });

  it("collapses a re-delivered webhook to a single persisted event (both layers)", async () => {
    const payload = cloverWebhookPayload("ORDER-DEDUP-1");

    const first = await ctx.app.inject({ method: "POST", url: "/api/clover/webhooks", payload });
    const second = await ctx.app.inject({ method: "POST", url: "/api/clover/webhooks", payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // First delivery is accepted (known merchant + orderId present), not ignored.
    expect(first.json()).toMatchObject({ ok: true, ignored: 0 });

    // ── BUSINESS INVARIANT ───────────────────────────────────────────────
    // Two identical deliveries => exactly one row in each dedup layer. If a
    // future refactor drops the @unique fingerprint or the skipDuplicates
    // flag, THESE are the assertions that catch it.
    const webhookRows = await ctx.services.prisma.cloverWebhookEvent.count({ where: { merchantId: MERCHANT_ID } });
    const providerRows = await ctx.services.prisma.kdsProviderEvent.count({ where: { merchantId: MERCHANT_ID } });
    expect(webhookRows).toBe(1);
    expect(providerRows).toBe(1);
    // ─────────────────────────────────────────────────────────────────────

    // The handler also self-reports the dedup on the second delivery.
    expect(second.json().deduped).toBeGreaterThanOrEqual(1);
  });

  it("collapses a resend with the same eventId but a different modifiedTime (GH #129)", async () => {
    // The exact gap the eventId switch closes: under the old content
    // fingerprint key (which folds in modifiedTime), this second delivery had a
    // DIFFERENT fingerprint and double-persisted. Keyed on (merchantId,
    // eventId) it must collapse to one L1 row.
    const orderId = "ORDER-RESEND-DIFF-MTIME";

    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/clover/webhooks",
      payload: cloverWebhookPayload(orderId, 1_700_000_000),
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/clover/webhooks",
      payload: cloverWebhookPayload(orderId, 1_700_009_999),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const webhookRows = await ctx.services.prisma.cloverWebhookEvent.count({ where: { merchantId: MERCHANT_ID } });
    expect(webhookRows).toBe(1);
  });

  it("does NOT collapse two genuinely-different events (dedup is precise, not blanket)", async () => {
    // Different orderId -> different fingerprint -> both must persist. A dedup
    // that silently dropped distinct orders would lose real kitchen tickets.
    await ctx.app.inject({ method: "POST", url: "/api/clover/webhooks", payload: cloverWebhookPayload("ORDER-A") });
    await ctx.app.inject({ method: "POST", url: "/api/clover/webhooks", payload: cloverWebhookPayload("ORDER-B") });

    const webhookRows = await ctx.services.prisma.cloverWebhookEvent.count({ where: { merchantId: MERCHANT_ID } });
    const providerRows = await ctx.services.prisma.kdsProviderEvent.count({ where: { merchantId: MERCHANT_ID } });
    expect(webhookRows).toBe(2);
    expect(providerRows).toBe(2);
  });
});
