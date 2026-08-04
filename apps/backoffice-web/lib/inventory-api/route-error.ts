import { NextResponse } from "next/server";

import { InventoryApiError, InventoryApiNotConfiguredError } from "./client";
import { redactSecrets } from "@/lib/redact";

// Shared mapping from upstream inventory-api failures to BFF responses, so all
// /api/inventory/* route handlers surface errors identically.
export function handleInventoryApiError(error: unknown, scope: string): NextResponse {
  if (error instanceof InventoryApiNotConfiguredError) {
    return NextResponse.json(
      { error: "inventory_not_configured", missing: error.missing },
      { status: 503 }
    );
  }
  if (error instanceof InventoryApiError) {
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
      message: redactSecrets(error instanceof Error ? error.message : "Unknown inventory route error")
    })
  );
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
