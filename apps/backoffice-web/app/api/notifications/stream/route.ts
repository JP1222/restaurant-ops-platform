import { type NextRequest } from "next/server";

import {
  handleNotificationsApiError,
  openNotificationsStream,
  operatorIdFromRequest
} from "@/lib/notifications-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SSE proxy: the browser's EventSource connects here (same-origin, session cookie);
// the BFF resolves the authenticated operator and pipes notifications-api's
// bearer-authenticated stream straight through, so the bell updates the moment a
// producer fires. `request.signal` aborts the upstream fetch when the browser
// disconnects, so the service tears down its subscription instead of leaking it.
// The 30s list poll remains the reconnect / missed-event fallback.
export async function GET(request: NextRequest) {
  const operatorId = await operatorIdFromRequest(request);
  if (!operatorId) {
    return new Response("unauthenticated", { status: 401 });
  }
  try {
    const upstream = await openNotificationsStream(operatorId, request.signal);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Tell nginx (and friends) not to buffer, so frames flush at once.
        "X-Accel-Buffering": "no"
      }
    });
  } catch (error) {
    // Browser disconnected before the upstream opened — nothing to report.
    if (request.signal.aborted) {
      return new Response(null, { status: 204 });
    }
    return handleNotificationsApiError(error, "backoffice.api.notifications.stream");
  }
}
