import type {
  ApplyActionRequest,
  ApplyActionResult,
  NotificationListResponse,
  NotificationPrefs,
  UpdatePrefsRequest
} from "@rop/contracts";
import { getServerEnv } from "@/lib/env";

// Server-side client for notifications-api. The browser never calls it directly
// (Iron Law 2/3): backoffice talks to it only through the BFF route handlers
// under app/api/notifications/*, which add the authenticated operator id.

export class NotificationsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly url: string
  ) {
    super(`notifications-api ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "NotificationsApiError";
  }
}

export class NotificationsApiNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`notifications-api not configured (missing: ${missing.join(", ")})`);
    this.name = "NotificationsApiNotConfiguredError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Stamped as `x-operator-role` for role-gated routes (the apply endpoint). */
  operatorRole?: string;
}

async function request<T>(path: string, operatorId: string, opts: RequestOptions = {}): Promise<T> {
  const env = getServerEnv();
  if (!env.INTERNAL_NOTIFICATIONS_API_URL) {
    throw new NotificationsApiNotConfiguredError(["INTERNAL_NOTIFICATIONS_API_URL"]);
  }

  const url = new URL(path, env.INTERNAL_NOTIFICATIONS_API_URL).toString();
  const headers: Record<string, string> = {
    Accept: "application/json",
    // The operator identity is supplied by the trusted BFF, never the browser.
    "x-operator-id": operatorId
  };
  // The operator's role for the manager-gated apply endpoint — also BFF-supplied
  // (the BFF has already run the authoritative RBAC check). notifications-api
  // re-gates on it server-side.
  if (opts.operatorRole) {
    headers["x-operator-role"] = opts.operatorRole;
  }
  // notifications-api bearer-guards every route.
  if (env.NOTIFICATIONS_INTERNAL_TOKEN) {
    headers.Authorization = `Bearer ${env.NOTIFICATIONS_INTERNAL_TOKEN}`;
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "omit",
    cache: "no-store"
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new NotificationsApiError(res.status, bodyText, url);
  }

  // 204-style mutation responses carry no useful body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Open the notifications-api SSE stream for one operator and return the raw upstream
 * Response for the BFF route to pipe to the browser. Unlike `request`, it must NOT
 * read the body — the body is a live, never-ending event stream. `signal` (the BFF
 * request's signal) aborts the upstream fetch when the browser disconnects, so
 * notifications-api tears down its subscription rather than leaking it.
 */
export async function openNotificationsStream(
  operatorId: string,
  signal?: AbortSignal
): Promise<Response> {
  const env = getServerEnv();
  if (!env.INTERNAL_NOTIFICATIONS_API_URL) {
    throw new NotificationsApiNotConfiguredError(["INTERNAL_NOTIFICATIONS_API_URL"]);
  }
  const url = new URL("/api/notifications/stream", env.INTERNAL_NOTIFICATIONS_API_URL).toString();
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "x-operator-id": operatorId
  };
  if (env.NOTIFICATIONS_INTERNAL_TOKEN) {
    headers.Authorization = `Bearer ${env.NOTIFICATIONS_INTERNAL_TOKEN}`;
  }
  const res = await fetch(url, {
    method: "GET",
    headers,
    credentials: "omit",
    cache: "no-store",
    signal
  });
  if (!res.ok || !res.body) {
    const bodyText = res.body ? await res.text().catch(() => "") : "";
    throw new NotificationsApiError(res.status, bodyText, url);
  }
  return res;
}

export const notificationsApi = {
  list: (operatorId: string) => request<NotificationListResponse>("/api/notifications", operatorId),
  markRead: (operatorId: string, id: string) =>
    request<unknown>(`/api/notifications/${encodeURIComponent(id)}/read`, operatorId, { method: "POST" }),
  dismiss: (operatorId: string, id: string) =>
    request<unknown>(`/api/notifications/${encodeURIComponent(id)}/dismiss`, operatorId, { method: "POST" }),
  snooze: (operatorId: string, id: string, until: string) =>
    request<unknown>(`/api/notifications/${encodeURIComponent(id)}/snooze`, operatorId, {
      method: "POST",
      body: { until }
    }),
  readAll: (operatorId: string) =>
    request<unknown>("/api/notifications/read-all", operatorId, { method: "POST" }),
  archiveRead: (operatorId: string) =>
    request<unknown>("/api/notifications/archive-read", operatorId, { method: "POST" }),
  getPrefs: (operatorId: string) =>
    request<NotificationPrefs>("/api/notifications/prefs", operatorId),
  updatePrefs: (operatorId: string, patch: UpdatePrefsRequest) =>
    request<NotificationPrefs>("/api/notifications/prefs", operatorId, { method: "PATCH", body: patch }),
  applyAction: (operatorId: string, operatorRole: string, body: ApplyActionRequest) =>
    request<ApplyActionResult>(
      `/api/notifications/${encodeURIComponent(body.notificationId)}/actions/apply`,
      operatorId,
      { method: "POST", body, operatorRole }
    )
};
