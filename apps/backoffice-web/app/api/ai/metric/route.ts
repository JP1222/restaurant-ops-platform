import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MetricRequestBody {
  name?: unknown;
  window?: unknown;
  dimensions?: unknown;
  filters?: unknown;
}

/**
 * BFF for the AI `get_metric` tool — the grounded read path (ADR-0030).
 * Resolves the active store like the typed analytics tools (so `get_metric`
 * and `get_today` agree on which store's numbers they return) and forwards to
 * analytics-api `/admin/api/metric`, whose `parseMetricRequest` is the single
 * schema source of truth for the window/dimensions/filters shape.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: MetricRequestBody;
  try {
    body = (await request.json()) as MetricRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Light sanity check only; analytics-api re-validates the full shape.
  if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 120) {
    return NextResponse.json({ error: "invalid_metric_name" }, { status: 400 });
  }
  if (typeof body.window !== "object" || body.window === null) {
    return NextResponse.json({ error: "invalid_window" }, { status: 400 });
  }

  const env = getServerEnv();
  const merchantId = await resolveAnalyticsMerchantId();
  const url = new URL("/admin/api/metric", env.INTERNAL_ANALYTICS_API_URL);
  if (merchantId) {
    url.searchParams.set("merchant_id", merchantId);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ANALYTICS_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: body.name,
        window: body.window,
        dimensions: body.dimensions,
        filters: body.filters,
      }),
      cache: "no-store",
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.metric",
      message: errorMessage(error, "upstream_fetch_failed"),
    });
    return NextResponse.json({ error: "analytics_upstream_unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const upstreamText = await upstream.text().catch(() => "");
    logErrorEvent({
      scope: "backoffice.api.ai.metric",
      message: upstreamText.slice(0, 500),
      context: { upstreamStatus: upstream.status },
    });
    return NextResponse.json(
      { error: "analytics_upstream_error", upstream_status: upstream.status },
      { status: upstream.status === 400 ? 400 : 502 },
    );
  }

  const payload = await upstream.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "analytics_invalid_payload" }, { status: 502 });
  }
  return NextResponse.json(payload);
}
