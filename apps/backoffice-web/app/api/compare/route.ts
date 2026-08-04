import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToTrends } from "@/lib/analytics-api/trends-transform";
import { transformToCompare } from "@/lib/compare/compare-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QuerySchema = z.object({
  primary_from: z.string().regex(ISO_DATE_RE),
  primary_to: z.string().regex(ISO_DATE_RE),
  compare_from: z.string().regex(ISO_DATE_RE),
  compare_to: z.string().regex(ISO_DATE_RE),
  metric: z.enum(["net_sales", "orders", "avg_ticket", "refund_rate", "discounts"]),
  grain: z.enum(["day", "week"]),
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_query", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const filters = parsed.data;
  if (filters.primary_from > filters.primary_to || filters.compare_from > filters.compare_to) {
    return NextResponse.json(
      { error: "invalid_range", message: "from must be <= to for both periods" },
      { status: 400 },
    );
  }

  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const [primarySales, compareSales] = await Promise.all([
      analyticsApi.sales({ from: filters.primary_from, to: filters.primary_to }, { merchantId }),
      analyticsApi.sales({ from: filters.compare_from, to: filters.compare_to }, { merchantId }),
    ]);

    const primary = transformToTrends(
      primarySales.daily,
      filters.metric,
      filters.grain,
      filters.primary_from,
      filters.primary_to,
    );
    const compare = transformToTrends(
      compareSales.daily,
      filters.metric,
      filters.grain,
      filters.compare_from,
      filters.compare_to,
    );

    return NextResponse.json(transformToCompare(primary, compare));
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.compare");
  }
}
