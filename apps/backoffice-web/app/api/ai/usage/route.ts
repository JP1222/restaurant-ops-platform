import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";
import { buildUsageReport, parseUsagePeriod } from "@/lib/ai/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF for the Settings → AI Assistant "Usage & cost" card. Aggregates the
 * ai_usage_events ledger by model + feature over a period and prices it via
 * priceFor (the LiteLLM-synced table). ?period=7d|month|last (default 7d).
 * Estimate only — not a billing source (see lib/ai/usage.ts disclaimer).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const period = parseUsagePeriod(request.nextUrl.searchParams.get("period"));

  try {
    const report = await buildUsageReport(period);
    return NextResponse.json(report);
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.usage.list",
      message: errorMessage(error, "usage_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
