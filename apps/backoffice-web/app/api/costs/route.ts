import { NextResponse } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.costs";
const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 90;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawDays = url.searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (rawDays != null) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) {
      return NextResponse.json({ error: "invalid_days" }, { status: 400 });
    }
    days = parsed;
  }

  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const payload = await analyticsApi.costs(days, { merchantId });
    return NextResponse.json(payload);
  } catch (error) {
    return handleAnalyticsApiError(error, SCOPE);
  }
}
