import { NextResponse } from "next/server";
import { kdsApi } from "@/lib/kds-api";
import { handleKdsBffError } from "@/lib/kds-api/bff-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE = "backoffice.api.admin.daily-reset";

export async function GET() {
  try {
    return NextResponse.json(await kdsApi.getDailyResetStatus());
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}

export async function POST() {
  try {
    return NextResponse.json(await kdsApi.triggerDailyReset());
  } catch (error) {
    return handleKdsBffError(SCOPE, error);
  }
}
