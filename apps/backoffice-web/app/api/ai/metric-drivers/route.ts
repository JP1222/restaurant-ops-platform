import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MetricDriversRequestBody {
  date?: unknown;
  top?: unknown;
}

/**
 * BFF for the AI `explain_metric_change` tool. Resolves the active store like the
 * other analytics tools and forwards to analytics-api `/admin/api/metric/drivers`,
 * whose schema is the single source of truth for the { date?, top? } shape. Returns
 * the per-dimension driver decomposition the model narrates "why sales moved" from.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: MetricDriversRequestBody;
  try {
    body = (await request.json()) as MetricDriversRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const env = getServerEnv();
  const merchantId = await resolveAnalyticsMerchantId();
  const url = new URL("/admin/api/metric/drivers", env.INTERNAL_ANALYTICS_API_URL);
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
      body: JSON.stringify({ date: body.date, top: body.top }),
      cache: "no-store",
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.metric-drivers",
      message: errorMessage(error, "upstream_fetch_failed"),
    });
    return NextResponse.json({ error: "analytics_upstream_unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const upstreamText = await upstream.text().catch(() => "");
    logErrorEvent({
      scope: "backoffice.api.ai.metric-drivers",
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
