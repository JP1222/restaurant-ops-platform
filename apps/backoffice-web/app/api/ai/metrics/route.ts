import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF for the AI `list_metrics` tool — returns the governed metric catalog
 * (names, definitions, units, allowed dimensions/filters) so the model can pick
 * a valid metric name before calling get_metric (ADR-0030 metric selection).
 * The catalog is merchant-independent, so no store scoping is applied here.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = getServerEnv();
  let upstream: Response;
  try {
    upstream = await fetch(`${env.INTERNAL_ANALYTICS_API_URL}/admin/api/metrics`, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.ANALYTICS_ADMIN_TOKEN}` },
      cache: "no-store",
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.metrics",
      message: errorMessage(error, "upstream_fetch_failed"),
    });
    return NextResponse.json({ error: "analytics_upstream_unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const upstreamText = await upstream.text().catch(() => "");
    logErrorEvent({
      scope: "backoffice.api.ai.metrics",
      message: upstreamText.slice(0, 500),
      context: { upstreamStatus: upstream.status },
    });
    return NextResponse.json(
      { error: "analytics_upstream_error", upstream_status: upstream.status },
      { status: 502 },
    );
  }

  const payload = await upstream.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "analytics_invalid_payload" }, { status: 502 });
  }
  return NextResponse.json(payload);
}
