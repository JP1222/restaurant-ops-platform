import { generateText } from "ai";

import {
  type WebSearchResult,
  type WebSearchSource,
  WebSearchSourceSchema,
} from "@rop/contracts";

import { createVisionProvider, MissingVisionKeyError } from "@/lib/ai/vision-provider";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getSetting } from "@/lib/settings";

/**
 * Read-only web search via Gemini "Grounding with Google Search" (Phase 2).
 *
 * DeepSeek (the default chat brain) has no native web search, so the chat's
 * `web_search` tool delegates here. We REUSE the existing Gemini provider + key
 * (`createVisionProvider()` / `ai.vision_api_key`, the same path invoice-scan
 * uses) — no new credential. The Gemini call grounds the answer against live
 * Google Search results and returns its web sources.
 *
 * Untrusted by design: the returned `answer`/`sources` are external web text, not
 * the operator's store data. Callers must treat them as untrusted context (the
 * system prompt says so) and the numeric guardrail excludes web-tool numbers from
 * its DB-verified source set (`lib/ai/web-tools.ts`).
 *
 * Fail-closed + graceful: when the Gemini key is missing, or the configured
 * vision model rejects the google_search tool, or any grounding error occurs,
 * this returns `{ available: false, answer: "", sources: [] }` — it NEVER throws
 * to the caller, so the BFF route stays a clean 200 with an "unavailable" payload
 * rather than a 500.
 */
export async function groundedWebSearch(query: string): Promise<WebSearchResult> {
  let provider: Awaited<ReturnType<typeof createVisionProvider>>;
  try {
    provider = await createVisionProvider();
  } catch (error) {
    if (error instanceof MissingVisionKeyError) {
      return { query, answer: "", sources: [], available: false };
    }
    throw error;
  }

  const modelId = await getSetting("ai.vision_model_id");

  try {
    const { text, sources } = await generateText({
      model: provider(modelId),
      tools: { google_search: provider.tools.googleSearch({}) },
      prompt: query,
    });

    // High-level normalized path: top-level `result.sources` exposes `{ sourceType,
    // title, url }` for grounded URLs (the raw groundingChunks path uses web.uri,
    // not web.url — we avoid it to keep coupling to the provider internals minimal).
    const urls: WebSearchSource[] = [];
    for (const source of sources) {
      if (source.sourceType !== "url") continue;
      // Validate each source against the canonical schema (drops non-http(s)
      // URLs) so one odd-scheme source from Gemini drops that source, not the
      // whole grounded answer — the route's WebSearchResultSchema.parse then
      // always succeeds rather than mapping a single bad URL to "unavailable".
      const candidate = WebSearchSourceSchema.safeParse({
        title: source.title ?? source.url,
        url: source.url,
      });
      if (!candidate.success) continue;
      urls.push(candidate.data);
      if (urls.length >= 10) break;
    }

    return { query, answer: text, sources: urls, available: true };
  } catch (error) {
    // A model that rejects google_search, or any other grounding failure, maps to
    // the same graceful "unavailable" result as a missing key — never a 500. Logged
    // so a misconfigured vision model is diagnosable without crashing the turn.
    logErrorEvent({
      scope: "backoffice.lib.ai.grounded-search",
      message: errorMessage(error, "grounded_search_failed"),
      context: { modelId },
    });
    return { query, answer: "", sources: [], available: false };
  }
}
