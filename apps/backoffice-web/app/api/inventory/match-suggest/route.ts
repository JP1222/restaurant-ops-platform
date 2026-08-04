import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { InventoryMatchSuggestRequestSchema } from "@rop/contracts";

import { isMissingAiConfigError } from "@/lib/ai/chat-provider";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { suggestCatalogMatches } from "@/lib/ai/match-suggest";
import { getAiSessionUser } from "@/lib/ai/session";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI semantic match for invoice receiving (ADR-0586 Phase 2A). The deterministic tiers
// (learned alias → fuzzy) run client-side first; this metered text call only resolves the
// residual lines. Gating contract: kill-switch, session OR internal-token auth (crew-web's
// Floor app has no AI provider and proxies here with INTERNAL_AI_TOKEN, mirroring the scan
// route), fail-closed 503 unkeyed. The model only picks from the candidate ids the client
// sends and the operator confirms — nothing here writes to stock.
//
// NOT rate-limited (unlike chat / receipt-parse): this is a best-effort assist the scan
// review screen fires on mount, and every caller swallows its failure silently. It can only
// run after a receipt-parse that already passed the `scan` limit, so that ceiling bounds it
// upstream; counting it here is what let one scan self-exhaust the shared bucket and 429 the
// user-visible parse. The kill switch remains the hard spend brake.
export async function POST(request: NextRequest): Promise<Response> {
  const killSwitch = await getSetting("ai.kill_switch");
  if (killSwitch) {
    return NextResponse.json({ error: "ai_disabled" }, { status: 503 });
  }

  const internalToken = process.env.INTERNAL_AI_TOKEN;
  const isInternal =
    Boolean(internalToken) && request.headers.get("authorization") === `Bearer ${internalToken}`;
  if (!isInternal && !(await getAiSessionUser(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = InventoryMatchSuggestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const [suggestions, threshold] = await Promise.all([
      suggestCatalogMatches(parsed.data),
      getSetting("ai.match_confidence_threshold"),
    ]);
    return NextResponse.json({ suggestions, threshold });
  } catch (error) {
    if (isMissingAiConfigError(error)) {
      return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });
    }
    logErrorEvent({
      scope: "backoffice.api.inventory.match-suggest",
      message: errorMessage(error, "match_suggest_failed"),
    });
    return NextResponse.json({ error: "match_suggest_failed" }, { status: 502 });
  }
}
