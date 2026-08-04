import {
  createPrismaClient,
  type AiConversation,
  type AiMessage,
  type PrismaClient,
} from "@rop/db-kds";

import type { ModelPrice } from "@/lib/ai/model-prices";

/**
 * Prisma helpers for AI conversation + message persistence.
 *
 * Uses the db-kds client on the dedicated `globalThis.__ropBackofficeKds.prisma`
 * singleton shared with the other db-kds consumers (settings, location), so AI
 * persistence doesn't open a second pool. Kept separate from the db-AUTH client
 * on `__ropBackofficeAuth.prisma` — disjoint schemas, so sharing that slot
 * after login left db-kds models undefined.
 */
type KdsGlobals = {
  prisma?: PrismaClient;
};

function getPrisma(): PrismaClient {
  const globals = globalThis as typeof globalThis & {
    __ropBackofficeKds?: KdsGlobals;
  };
  globals.__ropBackofficeKds ??= {};
  globals.__ropBackofficeKds.prisma ??= createPrismaClient();
  return globals.__ropBackofficeKds.prisma;
}

export async function createConversation(userId: string, title: string): Promise<AiConversation> {
  const trimmed = title.trim().slice(0, 200) || "Untitled";
  return getPrisma().aiConversation.create({
    data: { userId, title: trimmed },
  });
}

export type AiMessageRole = "user" | "assistant" | "system" | "tool";

interface AppendMessageStats {
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount?: number;
  latencyMs?: number;
}

export async function appendMessage(
  conversationId: string,
  role: AiMessageRole,
  content: unknown,
  stats?: AppendMessageStats,
): Promise<AiMessage> {
  return getPrisma().aiMessage.create({
    data: {
      conversationId,
      role,
      content: content as never,
      inputTokens: stats?.inputTokens,
      outputTokens: stats?.outputTokens,
      toolCallCount: stats?.toolCallCount,
      latencyMs: stats?.latencyMs,
    },
  });
}

export async function touchConversation(conversationId: string): Promise<AiConversation> {
  return getPrisma().aiConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

export type AiConversationListItem = Pick<AiConversation, "id" | "title" | "createdAt" | "updatedAt">;

export async function listConversations(
  userId: string,
  limit = 50,
): Promise<AiConversationListItem[]> {
  const take = Math.max(1, Math.min(100, Math.trunc(limit)));
  return getPrisma().aiConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
}

export type AiConversationWithMessages = AiConversation & { messages: AiMessage[] };

export async function getConversation(
  id: string,
  userId: string,
): Promise<AiConversationWithMessages | null> {
  return getPrisma().aiConversation.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
}

export async function deleteConversation(
  id: string,
  userId: string,
): Promise<AiConversation | null> {
  const owned = await getPrisma().aiConversation.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!owned) return null;
  return getPrisma().aiConversation.delete({ where: { id } });
}

// ── AI usage ledger (Usage & cost) ──────────────────────────────────────────
// Lean per-call token ledger, separate from conversation storage above. Written
// by every AI call (chat / vision_scan / matcher / emoji); read only by the
// usage aggregation. Content-free.

export type AiUsageFeature = "chat" | "vision_scan" | "matcher" | "emoji";

export interface AiUsageWrite {
  feature: AiUsageFeature;
  modelId: string;
  inputTokens?: number;
  /** Subset of inputTokens served from the prompt cache (priced cheaper). */
  cachedInputTokens?: number;
  outputTokens?: number;
}

// Persist one usage event. Awaitable + may throw — call sites use the
// fire-and-forget `recordAiUsage` wrapper (lib/ai/usage.ts) so a ledger hiccup
// never fails the underlying AI call. Non-finite/negative counts floor to 0.
export async function recordAiUsageEvent(event: AiUsageWrite): Promise<void> {
  const clamp = (n: number | undefined) =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  await getPrisma().aiUsageEvent.create({
    data: {
      feature: event.feature,
      modelId: event.modelId,
      inputTokens: clamp(event.inputTokens),
      cachedInputTokens: clamp(event.cachedInputTokens),
      outputTokens: clamp(event.outputTokens),
    },
  });
}

export interface AiUsageAggregateRow {
  feature: string;
  modelId: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

// Aggregate usage events in [since, until) grouped by (feature, modelId).
export async function aggregateAiUsageSince(
  since: Date,
  until: Date,
): Promise<AiUsageAggregateRow[]> {
  const grouped = await getPrisma().aiUsageEvent.groupBy({
    by: ["feature", "modelId"],
    where: { createdAt: { gte: since, lt: until } },
    _count: { _all: true },
    _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true },
  });
  return grouped.map((g) => ({
    feature: g.feature,
    modelId: g.modelId,
    requests: g._count._all,
    inputTokens: g._sum.inputTokens ?? 0,
    cachedInputTokens: g._sum.cachedInputTokens ?? 0,
    outputTokens: g._sum.outputTokens ?? 0,
  }));
}

// ── AI model price cache (Usage & cost) ─────────────────────────────────────
// Single-row JSON cache of the LiteLLM-synced price table, written by the
// Settings → AI "Refresh prices" action / weekly cron and read by the cost
// estimate. Lets the estimate price any selected model without a code change;
// the read path falls back to the committed table when this is empty.

const PRICE_CACHE_ID = "litellm";

export interface ModelPriceCache {
  prices: Record<string, ModelPrice>;
  modelCount: number;
  fetchedAt: Date;
}

export async function loadModelPriceCache(): Promise<ModelPriceCache | null> {
  const row = await getPrisma().aiModelPriceCache.findUnique({ where: { id: PRICE_CACHE_ID } });
  if (!row) return null;
  return {
    prices: (row.prices as unknown as Record<string, ModelPrice>) ?? {},
    modelCount: row.modelCount,
    fetchedAt: row.fetchedAt,
  };
}

export async function saveModelPriceCache(prices: Record<string, ModelPrice>): Promise<Date> {
  const fetchedAt = new Date();
  const modelCount = Object.keys(prices).length;
  await getPrisma().aiModelPriceCache.upsert({
    where: { id: PRICE_CACHE_ID },
    create: { id: PRICE_CACHE_ID, prices: prices as never, modelCount, fetchedAt },
    update: { prices: prices as never, modelCount, fetchedAt },
  });
  return fetchedAt;
}
