import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { WebSearchRequestSchema, WebSearchResultSchema } from "@rop/contracts";

import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { groundedWebSearch } from "@/lib/ai/grounded-search";
import { getAiSessionUser } from "@/lib/ai/session";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF for the AI `web_search` tool — the read-only grounded-search path (Phase 2,
 * AGENTS rule 13/14: each tool needs a backend typed endpoint, and the Gemini
 * provider SDK runs server-side only).
 *
 * Gating + fail-closed: the `ai.web_search_enabled` kill switch (default OFF)
 * gates the call, and a missing Gemini key / model error both resolve inside
 * `groundedWebSearch` to a clean `{ available: false }` payload. Every non-auth
 * path returns a 200 with a contract-shaped result — the tool never sees a 500,
 * so an injected/malformed query can't break the chat turn.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = WebSearchRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { query } = parsed.data;

  // Fail-closed kill switch: when web search is disabled (default), return the
  // clean "unavailable" shape rather than reaching out to Gemini. Reads through
  // getSetting's ~5s TTL cache, so flipping it off is a redeploy-free MTTR.
  const enabled = await getSetting("ai.web_search_enabled");
  if (!enabled) {
    return NextResponse.json({ query, answer: "", sources: [], available: false });
  }

  try {
    const result = await groundedWebSearch(query);
    // Re-validate at the boundary so the BFF only ever emits contract-shaped data.
    return NextResponse.json(WebSearchResultSchema.parse(result));
  } catch (error) {
    // groundedWebSearch is designed not to throw, but guard the boundary anyway:
    // any unexpected failure maps to the same graceful "unavailable" payload, not a 500.
    logErrorEvent({
      scope: "backoffice.api.ai.web-search",
      message: errorMessage(error, "web_search_failed"),
    });
    return NextResponse.json({ query, answer: "", sources: [], available: false });
  }
}
