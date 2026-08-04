import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DataTrustRequestBody {
  date?: unknown;
  lookback_days?: unknown;
}

/**
 * BFF for the AI `get_data_trust` tool. Resolves the active store like the other
 * analytics tools and forwards to analytics-api `/admin/api/data-trust`, whose
 * schema is the single source of truth for the { date, lookback_days } shape.
 * Returns the per-day reconciliation/data-quality verdict + caveat the model uses
 * to qualify "why did X move" answers when the data is under repair or settling.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: DataTrustRequestBody;
  try {
    body = (await request.json()) as DataTrustRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const env = getServerEnv();
  const merchantId = await resolveAnalyticsMerchantId();
  const url = new URL("/admin/api/data-trust", env.INTERNAL_ANALYTICS_API_URL);
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
        date: body.date,
        lookback_days: body.lookback_days,
      }),
      cache: "no-store",
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.data-trust",
      message: errorMessage(error, "upstream_fetch_failed"),
    });
    return NextResponse.json({ error: "analytics_upstream_unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const upstreamText = await upstream.text().catch(() => "");
    logErrorEvent({
      scope: "backoffice.api.ai.data-trust",
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
