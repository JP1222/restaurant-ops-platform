import { NextResponse, type NextRequest } from "next/server";
import { BackfillRequeueRequestSchema } from "@rop/contracts";
import { requireSession } from "@/lib/auth/require-session";
import { analyticsApi, handleAnalyticsApiError } from "@/lib/analytics-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Operator requeue of historical backfill windows (P4). Resets failed/blocked
// windows to pending in analytics-api so the autonomous scheduler reprocesses
// them — replaces the raw `UPDATE audit.sync_windows` psql workflow. Session-
// gated; the analytics admin token never reaches the browser.
export async function POST(request: NextRequest) {
  const unauth = await requireSession(request);
  if (unauth) return unauth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = BackfillRequeueRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", detail: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const result = await analyticsApi.requeueBackfill(parsed.data);
    console.info(
      JSON.stringify({
        level: "info",
        scope: "backoffice.api.ops.backfill",
        event: "requeue",
        action: parsed.data.action,
        requeuedWindows: result.requeuedWindows,
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return handleAnalyticsApiError(error, "backoffice.api.ops.backfill");
  }
}
