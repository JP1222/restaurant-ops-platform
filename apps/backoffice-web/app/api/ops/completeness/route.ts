import { NextResponse } from "next/server";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await analyticsApi.completeness());
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.ops.completeness");
  }
}
