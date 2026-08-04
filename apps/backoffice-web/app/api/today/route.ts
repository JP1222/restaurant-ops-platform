import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import { deriveTodayOpen } from "@rop/contracts";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { getCurrentBusinessDate, transformToToday } from "@/lib/analytics-api/today-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";
import { defaultStoreHoursResponse, readStoreHours } from "@/lib/location/store-hours";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const [sales, storeHours] = await Promise.all([
      analyticsApi.sales({ days: 30 }, { merchantId }),
      // Best-effort: the store-hours read hits db-kds, a different DB than analytics.
      // A blip there must not blank the dashboard — fall back to default framing.
      readStoreHours().catch(() => defaultStoreHoursResponse()),
    ]);
    // Frame the day against the store's own timezone + the real current weekday's
    // open time (Sunday opens at noon, not 10), both from the store's Location.
    const tz = storeHours.timezone;
    const todayOpen = deriveTodayOpen(storeHours.hours, DateTime.now().setZone(tz).weekday % 7);
    const shaped = transformToToday(sales.daily, {
      currentBusinessDate: getCurrentBusinessDate(tz),
      storeTimeZone: tz,
      todayOpen,
    });

    if (!shaped) {
      return NextResponse.json(
        { error: "no_data", message: "No sales data available." },
        { status: 404 },
      );
    }

    return NextResponse.json(shaped);
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.today");
  }
}
