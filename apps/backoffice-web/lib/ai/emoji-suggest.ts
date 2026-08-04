import { generateObject } from "ai";
import { z } from "zod";

import type {
  InventoryEmojiSuggestRequest,
  InventoryEmojiSuggestion,
} from "@rop/contracts";

import { resolveMatcherTarget } from "@/lib/ai/chat-provider";
import { withTextFallback } from "@/lib/ai/text-fallback";
import { recordAiUsage } from "@/lib/ai/usage";

// Model-facing schema: one emoji per item, echoing the input index. Required-but-present
// fields read more reliably out of JSON mode than optionals (same discipline as
// match-suggest / receipt-parse). An empty `emoji` string means "the model found nothing".
const SuggestSchema = z.object({
  suggestions: z.array(
    z.object({
      index: z.number().int(),
      emoji: z.string(),
    }),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT — the one knob that shapes suggestion quality. This is the merchant's
// catalog vocabulary talking (ice-cream / bubble-tea / quick-serve), so it's worth
// tuning by hand. Keep it instructing the model to return EXACTLY ONE emoji per item
// (no words/punctuation) and to fall back to "" when nothing fits — the sanitizer
// below is the safety net, but a good prompt means it rarely has to fire.
const PROMPT = [
  "You assign a single emoji icon to restaurant inventory items for an ice-cream /",
  "bubble-tea / quick-serve shop. You are given items as `[index] name`. For EACH item,",
  "return the ONE emoji that best represents what a cook would grab off the shelf.",
  "Return exactly one emoji glyph per item — no words, no punctuation, no extra text.",
  "Prefer the food/drink/ingredient itself, ignoring brand and pack wording: e.g.",
  '"Member\'s Mark Whole Milk 12 oz" -> 🥛, "Strawberry" -> 🍓, "Boba Pearls" -> 🟤,',
  '"To-go Cups" -> 🥤, "Bleach" -> 🧼. If no emoji fits the item, return an empty string',
  "for that item's emoji rather than forcing a wrong one. Return one suggestion per input",
  "item, echoing its index.",
].join(" ");
// ─────────────────────────────────────────────────────────────────────────────

// First grapheme cluster via Intl.Segmenter (Node 18+), so a stray "🥛 milk" collapses
// to "🥛" before validation. Constructing a Segmenter is cheap but not free, so build once.
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function firstGrapheme(value: string): string {
  if (!graphemeSegmenter) return value;
  const next = graphemeSegmenter.segment(value)[Symbol.iterator]().next();
  return next.done ? value : next.value.segment;
}

// Guard the model's free-form output back to a single real emoji glyph. JSON mode can still
// return a word ("milk"), a sentence, an empty string, or several glyphs. We take the first
// grapheme, require a pictographic codepoint, and reject anything carrying ASCII letters or
// digits. Failures map to "" — the caller leaves the icon empty and the UI falls back to the
// category glyph (never a broken tofu box). Exported for unit coverage.
export function sanitizeEmoji(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const glyph = firstGrapheme(trimmed);
  if (/[A-Za-z0-9]/u.test(glyph)) return "";
  if (!/\p{Extended_Pictographic}/u.test(glyph)) return "";
  return glyph.slice(0, 32);
}

// Ask the model for one emoji per item name. Deterministic guards around the model: the
// emoji is sanitized to a single glyph (hallucination/word guard) and a missing index is
// dropped, so the caller only ever sees `{ index, emoji }` with a clean glyph or "". The
// caller fills the icon only when the item has none (never clobbers a manual pick) — nothing
// here writes to the catalog. Throws a Missing*…Error (→ 503 at the route) when the selected
// matcher provider is unconfigured.
export async function suggestEmojis(
  req: InventoryEmojiSuggestRequest,
): Promise<InventoryEmojiSuggestion[]> {
  if (req.names.length === 0) {
    return [];
  }
  // Shares the matcher's provider/model (ai.match_provider + ai.match_model_id) — a text-only
  // call, independent of the chat brain. withTextFallback retries once on
  // ai.text_fallback_model_id (same provider) if the primary model call fails.
  const target = await resolveMatcherTarget();

  const itemList = req.names.map((n) => `[${n.index}] ${n.name}`).join("\n");

  const outcome = await withTextFallback(target, (model) =>
    generateObject({
      model,
      schema: SuggestSchema,
      messages: [
        {
          role: "user",
          content: `${PROMPT}\n\nITEMS:\n${itemList}`,
        },
      ],
    }),
  );
  const { object, usage } = outcome.result;

  // Usage & cost ledger (fire-and-forget), attributed to the model that ran.
  recordAiUsage({
    feature: "emoji",
    modelId: outcome.modelId,
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    outputTokens: usage?.outputTokens,
  });

  const requested = new Set(req.names.map((n) => n.index));
  return object.suggestions
    .filter((s) => requested.has(s.index))
    .map((s) => ({ index: s.index, emoji: sanitizeEmoji(s.emoji) }));
}
