import { generateObject } from "ai";
import { z } from "zod";

import type {
  InventoryMatchSuggestRequest,
  InventoryMatchSuggestion,
} from "@rop/contracts";

import { resolveMatcherTarget } from "@/lib/ai/chat-provider";
import { withTextFallback } from "@/lib/ai/text-fallback";
import { recordAiUsage } from "@/lib/ai/usage";

// Model-facing schema (ADR-0586 Phase 2A): the chat brain picks, per line, the SINGLE
// best catalog item id (or null) plus a confidence. Required-but-nullable item_id reads
// more reliably out of JSON mode than an optional field (same discipline as receipt-parse).
const SuggestSchema = z.object({
  suggestions: z.array(
    z.object({
      index: z.number().int(),
      item_id: z.string().nullable(),
      confidence: z.number(),
    }),
  ),
});

const PROMPT = [
  "You match restaurant vendor-invoice line items to an EXISTING inventory catalog.",
  "You are given catalog candidates (one per line as `id<TAB>name`) and invoice lines (as `[index] text`).",
  "For each invoice line, pick the SINGLE candidate id that refers to the SAME product (same thing a cook would",
  "grab off the shelf), or null when no candidate is a good match. The `item_id` MUST be copied EXACTLY from a",
  "candidate id (the part before the tab) — never invent or modify an id. Give `confidence` 0..1 (1 = certainly",
  "the same product, 0.5 = plausible, <0.3 = weak). Match on meaning, ignoring brand/pack wording: e.g. an",
  "invoice line \"MEMBER'S MARK WHOLE MILK 12 OZ\" matches a catalog \"Milk 12 oz\". Return one suggestion per line.",
].join(" ");

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// Ask the model to map unresolved invoice lines to existing catalog items. Deterministic
// guards around the model (ADR-0538 D3): an item_id the model returns that is NOT one of
// the supplied candidate ids is coerced to null (hallucination guard), and confidence is
// clamped to 0..1. The caller still gates on the confidence threshold and the operator
// confirms — nothing here writes to stock. Throws a Missing*…Error (→503) when the selected
// matcher provider is unconfigured.
export async function suggestCatalogMatches(
  req: InventoryMatchSuggestRequest,
): Promise<InventoryMatchSuggestion[]> {
  if (req.lines.length === 0 || req.candidates.length === 0) {
    return [];
  }
  // Runs on the matcher's OWN provider/model (ai.match_provider + ai.match_model_id),
  // independent of the chat brain — switching chat never disturbs receipt matching, and the
  // matcher can point at any configured provider (default DeepSeek). withTextFallback retries
  // once on ai.text_fallback_model_id (same provider) if the primary model call fails.
  const target = await resolveMatcherTarget();
  const validIds = new Set(req.candidates.map((c) => c.id));

  const candidateList = req.candidates.map((c) => `${c.id}\t${c.name}`).join("\n");
  const lineList = req.lines.map((l) => `[${l.index}] ${l.text}`).join("\n");

  const outcome = await withTextFallback(target, (model) =>
    generateObject({
      model,
      schema: SuggestSchema,
      messages: [
        {
          role: "user",
          content: `${PROMPT}\n\nCANDIDATES:\n${candidateList}\n\nINVOICE LINES:\n${lineList}`,
        },
      ],
    }),
  );
  const { object, usage } = outcome.result;

  // Usage & cost ledger (fire-and-forget), attributed to the model that ran.
  recordAiUsage({
    feature: "matcher",
    modelId: outcome.modelId,
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    outputTokens: usage?.outputTokens,
  });

  return object.suggestions.map((s) => ({
    index: s.index,
    item_id: s.item_id && validIds.has(s.item_id) ? s.item_id : null,
    confidence: clamp01(s.confidence),
  }));
}
