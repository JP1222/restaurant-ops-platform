import { NextResponse } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToDayparts } from "@/lib/analytics-api/dayparts-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.dayparts";
const DEFAULT_DAYS = 56; // 8 weeks — enough samples per weekday-hour to stabilize averages.
const MAX_DAYS = 90;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawDays = url.searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (rawDays != null) {
    const parsed = Number(rawDays);
    if (Number.isInteger(parsed) && parsed >= 7 && parsed <= MAX_DAYS) {
      days = parsed;
    }
  }

  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const rows = await analyticsApi.hourly(days, { merchantId });
    const shaped = transformToDayparts(rows);
    if (!shaped) {
      return NextResponse.json(
        { error: "no_data", message: "No hourly data available." },
        { status: 404 }
      );
    }
    return NextResponse.json(shaped);
  } catch (error) {
    return handleAnalyticsApiError(error, SCOPE);
  }
}
