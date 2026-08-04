import type { LanguageModel } from "ai";

import type { AiChatProvider } from "@rop/contracts";

import { resolveLanguageModel } from "@/lib/ai/chat-provider";
import { getSetting } from "@/lib/settings";

export interface TextModelTarget {
  provider: AiChatProvider;
  modelId: string;
}

export interface TextFallbackOutcome<T> {
  result: T;
  /** The model id that actually produced `result` — primary, or the fallback if it escalated. */
  modelId: string;
  fallbackUsed: boolean;
}

/**
 * Run a discrete (non-streaming) model call with retry-once on the configured text
 * fallback model. Mirrors the vision-fallback escalation in receipt-parse.ts, for the
 * unattended scan-flow TEXT calls (receipt matcher / emoji suggester).
 *
 * `runWith(model)` performs the actual `generateObject` / `generateText`. The primary
 * model (target.provider + target.modelId) runs first; if it throws and
 * `ai.text_fallback_model_id` is set (and differs from the primary id), the call is
 * retried ONCE on the SAME provider with the fallback model id — so the fallback reuses
 * the already-configured credential and only swaps the (cheaper / less-loaded) model.
 *
 * Retry policy is intentionally "retry on any primary failure": the path is best-effort
 * (a total failure degrades silently upstream), the fallback uses a DIFFERENT model id so
 * even a deprecated/invalid primary id can succeed on retry, and a permanent error (e.g. a
 * missing key) simply re-throws from the fallback attempt — one wasted call on an
 * already-failing best-effort path is an acceptable cost for the simpler, provider-agnostic
 * rule. A fallback failure propagates to the caller (no third attempt).
 *
 * The chat assistant is deliberately NOT on this path: it streams and is interactive (a
 * user just resends), so a mid-stream model swap would buy little at real complexity cost.
 */
export async function withTextFallback<T>(
  target: TextModelTarget,
  runWith: (model: LanguageModel) => Promise<T>,
): Promise<TextFallbackOutcome<T>> {
  const primary = await resolveLanguageModel(target.provider, target.modelId);
  try {
    return { result: await runWith(primary), modelId: target.modelId, fallbackUsed: false };
  } catch (primaryError) {
    const fallbackId = (await getSetting("ai.text_fallback_model_id")).trim();
    // No fallback configured, or it's the same id we just tried — nothing new to attempt.
    if (!fallbackId || fallbackId === target.modelId) throw primaryError;
    const fallback = await resolveLanguageModel(target.provider, fallbackId);
    const result = await runWith(fallback);
    return { result, modelId: fallbackId, fallbackUsed: true };
  }
}
