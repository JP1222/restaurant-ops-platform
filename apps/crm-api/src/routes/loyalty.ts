import type { FastifyInstance } from "fastify";

import type { LoyaltyCohortsResponse } from "@rop/contracts";

import {
  EnrollRequestSchema,
  type BalanceResponse,
  type CustomerSummary,
  type HistoryResponse,
  type RewardCatalogResponse
} from "../domain/dto.js";
import { normalizeE164 } from "../domain/phone.js";
import { computeRfmCohorts, type MemberFacts } from "../domain/rfm.js";
import type { AppServices } from "../lib/services.js";

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

// Prisma unique-constraint violation. phoneE164 is @unique, so a concurrent
// same-phone enroll loses the insert race with this code (GH #465).
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export async function registerLoyaltyRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma } = services;

  // Public reward catalog (the redemption ladder). Owner-editable via the
  // CrmReward table; returns only active rungs, cheapest first.
  app.get("/api/loyalty/rewards", async (): Promise<RewardCatalogResponse> => {
    const rewards = await prisma.crmReward.findMany({
      where: { active: true },
      orderBy: { costPoints: "asc" }
    });
    return {
      rewards: rewards.map((r) => ({
        slug: r.slug,
        label: r.label,
        cost_points: r.costPoints,
        kind: r.kind,
        value_cents: r.valueCents
      }))
    };
  });

  // Enroll — idempotent by phone (re-enrolling an existing number returns the
  // member, never a duplicate). Bearer-guarded. Phone is normalized to E.164
  // first (ADR-0024: one identity per number); an unrecognizable number is
  // rejected rather than mis-keyed.
  app.post("/api/loyalty/enroll", async (request, reply) => {
    const parsed = EnrollRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid enrollment", issues: parsed.error.issues });
    }
    const phoneE164 = normalizeE164(parsed.data.phone);
    if (!phoneE164) {
      return reply.code(400).send({ error: "Unrecognized phone number" });
    }

    const existing = await prisma.crmCustomer.findUnique({ where: { phoneE164 } });
    let customer = existing;
    let created = false;
    if (!customer) {
      try {
        customer = await prisma.crmCustomer.create({
          data: {
            phoneE164,
            displayName: parsed.data.displayName ?? null,
            email: parsed.data.email ?? null,
            birthMonth: parsed.data.birthMonth ?? null,
            marketingSmsConsent: parsed.data.marketingSmsConsent ?? false,
            // 1:1 loyalty account created alongside the customer.
            account: { create: {} }
          }
        });
        created = true;
      } catch (cause) {
        // A concurrent enroll for the same phone won the insert: re-read and
        // return the existing member (200) instead of a 500, preserving the
        // documented idempotent-by-phone contract (GH #465).
        if (!isUniqueConstraintError(cause)) {
          throw cause;
        }
        customer = await prisma.crmCustomer.findUnique({ where: { phoneE164 } });
        if (!customer) {
          throw cause;
        }
      }
    }

    const summary: CustomerSummary = {
      phone_e164: customer.phoneE164,
      display_name: customer.displayName,
      birth_month: customer.birthMonth,
      marketing_sms_consent: customer.marketingSmsConsent,
      enrolled_at: customer.createdAt.toISOString()
    };
    return reply.code(created ? 201 : 200).send(summary);
  });

  // Balance (PII) — reads the cached projection on CrmLoyaltyAccount, never sums
  // the ledger. Bearer-guarded.
  app.get("/api/loyalty/balance", async (request, reply) => {
    const phone = (request.query as { phone?: string }).phone;
    if (!phone) {
      return reply.code(400).send({ error: "phone query param required" });
    }
    const phoneE164 = normalizeE164(phone);
    if (!phoneE164) {
      return reply.code(400).send({ error: "Unrecognized phone number" });
    }
    const customer = await prisma.crmCustomer.findUnique({
      where: { phoneE164 },
      include: { account: true }
    });
    if (!customer?.account) {
      return reply.code(404).send({ error: "Not enrolled" });
    }
    const a = customer.account;
    const body: BalanceResponse = {
      phone_e164: customer.phoneE164,
      balance_points: a.balancePoints,
      pending_points: a.pendingPoints,
      lifetime_earned: a.lifetimeEarned,
      lifetime_redeemed: a.lifetimeRedeemed,
      lifetime_eligible_spend_cents: a.lifetimeEligibleSpendCents,
      last_activity_at: a.lastActivityAt ? a.lastActivityAt.toISOString() : null
    };
    return body;
  });

  // History (PII) — ledger rows redacted to the customer-safe fields, newest
  // first. Bearer-guarded.
  app.get("/api/loyalty/history", async (request, reply) => {
    const q = request.query as { phone?: string; limit?: string };
    if (!q.phone) {
      return reply.code(400).send({ error: "phone query param required" });
    }
    const phoneE164 = normalizeE164(q.phone);
    if (!phoneE164) {
      return reply.code(400).send({ error: "Unrecognized phone number" });
    }
    const customer = await prisma.crmCustomer.findUnique({
      where: { phoneE164 },
      include: { account: true }
    });
    if (!customer?.account) {
      return reply.code(404).send({ error: "Not enrolled" });
    }
    const limit = Math.min(Math.max(Number(q.limit) || HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
    const rows = await prisma.crmPointsLedger.findMany({
      where: { accountId: customer.account.id },
      orderBy: { occurredAt: "desc" },
      take: limit
    });
    const body: HistoryResponse = {
      phone_e164: customer.phoneE164,
      entries: rows.map((r) => ({
        type: r.type,
        points: r.points,
        status: r.status,
        source: r.source,
        occurred_at: r.occurredAt.toISOString()
      }))
    };
    return body;
  });

  // Guest cohorts (RFM) — operator analytics for the backoffice /guests page.
  // Aggregate-only: counts + cents per segment, never a phone or name, so loyalty
  // PII never leaves crm-api. Bearer-guarded by the /api/loyalty preHandler.
  //
  // Monetary + recency come straight off the CrmLoyaltyAccount projection. Frequency
  // is the one figure the projection doesn't cache, so it is a single groupBy over
  // the ledger restricted to spend-derived EARN rows (eligibleSubtotalCents non-null
  // excludes signup/referral/birthday bonus credit). That is an on-demand analytics
  // aggregate across all members, not the per-customer balance hot path the
  // "read the projection, never sum the ledger" rule guards.
  app.get("/api/loyalty/cohorts", async (): Promise<LoyaltyCohortsResponse> => {
    const accounts = await prisma.crmLoyaltyAccount.findMany({
      select: { id: true, lifetimeEligibleSpendCents: true, lastActivityAt: true }
    });
    const freqRows = await prisma.crmPointsLedger.groupBy({
      by: ["accountId"],
      where: { type: "EARN", eligibleSubtotalCents: { not: null } },
      _count: { _all: true }
    });
    const freqByAccount = new Map(freqRows.map((r) => [r.accountId, r._count._all]));

    const members: MemberFacts[] = accounts.map((a) => ({
      monetaryCents: a.lifetimeEligibleSpendCents,
      frequency: freqByAccount.get(a.id) ?? 0,
      lastActivityAt: a.lastActivityAt
    }));
    return computeRfmCohorts(members, new Date());
  });
}
