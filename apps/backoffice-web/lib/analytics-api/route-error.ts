import { NextResponse } from "next/server";

import { redactSecrets } from "@/lib/redact";
import { AnalyticsApiError } from "./client";

// Shared mapping from upstream analytics-api failures to BFF responses, so every
// analytics/today/menu/trends/ops route handler surfaces errors identically.
// Redaction (audit-2026-05-27 #157) lives here once instead of being hand-copied
// into each route's catch block. Mirrors handleInventoryApiError in
// lib/inventory-api/route-error.ts and githubErrorResponse in lib/ops/route-helpers.ts.
export function handleAnalyticsApiError(error: unknown, scope: string): NextResponse {
  if (error instanceof AnalyticsApiError) {
    console.error(
      JSON.stringify({
        level: "error",
        scope,
        requestId: error.requestId,
        upstreamStatus: error.status,
        message: redactSecrets(error.bodyText.slice(0, 500))
      })
    );
    return NextResponse.json(
      { error: "upstream_error", upstream_status: error.status },
      { status: 502 }
    );
  }
  console.error(
    JSON.stringify({
      level: "error",
      scope,
      message: redactSecrets(error instanceof Error ? error.message : "Unknown analytics route error")
    })
  );
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
