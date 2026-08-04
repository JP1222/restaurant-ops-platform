import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";
import { transformToTrends } from "@/lib/analytics-api/trends-transform";
import { resolveAnalyticsMerchantId } from "@/lib/location/scope";

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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

  const { from, to, metric, grain } = parsed.data;
  if (from > to) {
    return NextResponse.json(
      { error: "invalid_range", message: "from must be <= to" },
      { status: 400 },
    );
  }

  try {
    const merchantId = await resolveAnalyticsMerchantId();
    const sales = await analyticsApi.sales({ from, to }, { merchantId });
    const view = transformToTrends(sales.daily, metric, grain, from, to);

    return NextResponse.json(view);
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.trends");
  }
}
