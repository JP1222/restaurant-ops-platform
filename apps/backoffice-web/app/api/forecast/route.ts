import { NextResponse, type NextRequest } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { getSessionUser } from "@/lib/auth/session-user";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Read the stored demand forecast (curve + band + backtest) for the active store.
export async function GET() {
  try {
    const merchantId = await resolveAnalyticsMerchantId();
    return NextResponse.json(await analyticsApi.forecast({ merchantId }));
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.forecast");
  }
}

// Recompute the forecast on demand (the "Refresh" button). A compute trigger, so it
// requires a session; the read above is gated by the proxy like the other analytics reads.
export async function POST(request: NextRequest) {
  const operator = await getSessionUser(request);
  if (!operator) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const merchantId = await resolveAnalyticsMerchantId();
    return NextResponse.json(await analyticsApi.runForecast({ merchantId }));
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.forecast.run");
  }
}
