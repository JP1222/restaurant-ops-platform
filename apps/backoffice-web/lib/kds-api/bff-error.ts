import { NextResponse } from "next/server";
import { KdsApiError, KdsApiNotConfiguredError } from "./client";
import { redactSecrets } from "@/lib/redact";

export function handleKdsBffError(scope: string, error: unknown): NextResponse {
  if (error instanceof KdsApiNotConfiguredError) {
    return NextResponse.json(
      { error: "admin_not_configured", missing: error.missing },
      { status: 503 }
    );
  }

  if (error instanceof KdsApiError) {
    let upstreamBody: unknown = null;
    try {
      upstreamBody = JSON.parse(error.bodyText);
    } catch {
      upstreamBody = error.bodyText.slice(0, 500);
    }
    console.error(
      JSON.stringify({
        level: "error",
        scope,
        requestId: error.requestId,
        upstreamStatus: error.status,
        message:
          typeof error.bodyText === "string" ? redactSecrets(error.bodyText.slice(0, 500)) : "no body"
      })
    );
    // Pass through user-actionable upstream errors (4xx) so the UI can show
    // "username taken" / "user not found" / "last admin" etc. directly.
    if (error.status >= 400 && error.status < 500) {
      return NextResponse.json(
        { error: "upstream_error", upstream_status: error.status, upstream: upstreamBody },
        { status: error.status }
      );
    }
    return NextResponse.json(
      { error: "upstream_error", upstream_status: error.status },
      { status: 502 }
    );
  }

  console.error(
    JSON.stringify({
      level: "error",
      scope,
      message: redactSecrets(error instanceof Error ? error.message : "Unknown BFF error")
    })
  );
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
