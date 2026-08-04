import { DateTime } from "luxon";
import { NextResponse, type NextRequest } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToHourlyPulse } from "@/lib/analytics-api/hourly-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";
import { resolveStoreTimeZone } from "@/lib/location/store-hours";

const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 90;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function resolveDays(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get("days");
  if (raw === null) return DEFAULT_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  const truncated = Math.trunc(parsed);
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, truncated));
}

export async function GET(request: NextRequest) {
  const days = resolveDays(request);
  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const [rows, tz] = await Promise.all([
      analyticsApi.hourly(days, { merchantId }),
      resolveStoreTimeZone(),
    ]);
    const shaped = transformToHourlyPulse(rows, DateTime.now().setZone(tz));

    if (!shaped) {
      return NextResponse.json(
        { error: "no_data", message: "No hourly data available." },
        { status: 404 },
      );
    }

    return NextResponse.json(shaped);
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.today.hourly");
  }
}
