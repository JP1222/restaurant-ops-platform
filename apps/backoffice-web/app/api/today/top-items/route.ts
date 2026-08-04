import { NextResponse, type NextRequest } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToTopItems } from "@/lib/analytics-api/top-items-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
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
    const response = await analyticsApi.items(days, { merchantId });
    return NextResponse.json(transformToTopItems(response.items, response.days));
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.today.top-items");
  }
}
