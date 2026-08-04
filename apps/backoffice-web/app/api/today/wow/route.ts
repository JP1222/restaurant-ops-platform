import { NextResponse } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToWeekVsWeek } from "@/lib/analytics-api/wow-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const sales = await analyticsApi.sales({ days: 14 }, { merchantId });
    const shaped = transformToWeekVsWeek(sales.daily);

    if (!shaped) {
      return NextResponse.json(
        { error: "no_data", message: "No week-over-week sales data available." },
        { status: 404 },
      );
    }

    return NextResponse.json(shaped);
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.today.wow");
  }
}
