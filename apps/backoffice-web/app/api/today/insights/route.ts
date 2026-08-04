import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToHourlyPulse } from "@/lib/analytics-api/hourly-transform";
import { getCurrentBusinessDate, transformToToday } from "@/lib/analytics-api/today-transform";
import { type InsightsResponse, InsightsResponseSchema } from "@rop/contracts";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";
import { resolveStoreTimeZone } from "@/lib/location/store-hours";
import { runInsights } from "@/lib/insights/rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const [sales, hourlyRows, tz] = await Promise.all([
      analyticsApi.sales({ days: 30 }, { merchantId }),
      analyticsApi.hourly(30, { merchantId }),
      resolveStoreTimeZone(),
    ]);

    const today = transformToToday(sales.daily, {
      currentBusinessDate: getCurrentBusinessDate(tz),
      storeTimeZone: tz,
    });

    if (!today) {
      const empty: InsightsResponse = { insights: [], all_clear: true };
      return NextResponse.json(empty);
    }

    const hourly = transformToHourlyPulse(hourlyRows, DateTime.now().setZone(tz));
    const insights = runInsights({ today, hourly });
    const body = InsightsResponseSchema.parse({
      insights,
      all_clear: insights.length === 0,
    });

    return NextResponse.json(body);
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.today.insights");
  }
}
