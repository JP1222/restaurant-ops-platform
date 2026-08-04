import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { refreshModelPrices } from "@/lib/ai/refresh-prices";
import { getAiSessionUser } from "@/lib/ai/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ai/prices/refresh — re-sync the model price table from LiteLLM's public
 * price map into the cache the Usage & cost estimate reads, so newly-selected models
 * get priced without a code change. Drives the Settings → AI "Refresh prices" button
 * AND the weekly cron (.github/workflows/ai-prices-refresh.yml).
 *
 * Auth: an operator session (the button) OR the cron's bearer token
 * (AI_PRICES_REFRESH_TOKEN). The token branch is dormant until that env is provisioned —
 * when unset only a session works — mirroring the INTERNAL_AI_TOKEN proxy pattern.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  const cronToken = process.env.AI_PRICES_REFRESH_TOKEN;
  const isCron =
    Boolean(cronToken) && request.headers.get("authorization") === `Bearer ${cronToken}`;
  if (!user && !isCron) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await refreshModelPrices();
    return NextResponse.json(result);
  } catch (error) {
    // A LiteLLM fetch failure leaves the prior cache intact; surface a 502 so the UI
    // can offer a retry rather than implying the prices changed.
    logErrorEvent({
      scope: "backoffice.api.ai.prices.refresh",
      message: errorMessage(error, "price_refresh_failed"),
    });
    return NextResponse.json({ error: "price_refresh_failed" }, { status: 502 });
  }
}
