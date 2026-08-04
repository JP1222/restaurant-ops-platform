import { getSessionFromCookies } from "@rop/auth/next";
import { NextResponse, type NextRequest } from "next/server";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { redactSecrets } from "@/lib/redact";
import {
  NotificationsApiError,
  NotificationsApiNotConfiguredError,
  notificationsApi,
  openNotificationsStream
} from "./client";

export {
  notificationsApi,
  openNotificationsStream,
  NotificationsApiError,
  NotificationsApiNotConfiguredError
};

/** The authenticated backoffice operator id (the account username), or null. */
export async function operatorIdFromRequest(request: NextRequest): Promise<string | null> {
  const auth = getBackofficeAuthService();
  const session = await getSessionFromCookies(request.cookies, auth, {
    cookieName: getBackofficeSessionCookieName()
  });
  return session?.username ?? null;
}

// Maps service errors to BFF responses. A missing service config is the honest
// "not connected yet" 503 (the client keeps showing sample data), distinct from
// a genuine upstream failure.
export function handleNotificationsApiError(error: unknown, scope: string): NextResponse {
  if (error instanceof NotificationsApiNotConfiguredError) {
    return NextResponse.json(
      { error: "notifications_not_configured", missing: error.missing },
      { status: 503 }
    );
  }
  if (error instanceof NotificationsApiError) {
    console.error(
      JSON.stringify({
        level: "error",
        scope,
        upstreamStatus: error.status,
        message: redactSecrets(error.bodyText.slice(0, 500))
      })
    );
    return NextResponse.json({ error: "upstream_error", upstream_status: error.status }, { status: 502 });
  }
  console.error(
    JSON.stringify({
      level: "error",
      scope,
      message: redactSecrets(error instanceof Error ? error.message : "Unknown notifications route error")
    })
  );
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
