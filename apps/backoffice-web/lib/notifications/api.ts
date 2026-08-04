import type {
  ApplyActionResult,
  Notification as NotificationDto,
  NotificationPrefs,
  UpdatePrefsRequest
} from "@rop/contracts";

// Browser → backoffice BFF wrappers (the BFF proxies to notifications-api or
// answers 503 when the service isn't configured). A 503 list/prefs returns null
// — the honest "not connected" signal that keeps the client on its sample seed.

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
}

export const notificationsBff = {
  list: async (): Promise<{ notifications: NotificationDto[] } | null> => {
    const res = await fetch("/api/notifications", { credentials: "include" });
    if (res.status === 503) return null;
    if (!res.ok) throw new Error(`/api/notifications ${res.status}`);
    return res.json();
  },
  getPrefs: async (): Promise<NotificationPrefs | null> => {
    const res = await fetch("/api/notifications/prefs", { credentials: "include" });
    if (res.status === 503) return null;
    if (!res.ok) throw new Error(`/api/notifications/prefs ${res.status}`);
    return res.json();
  },
  markRead: (id: string) => post(`/api/notifications/${encodeURIComponent(id)}`, { action: "read" }),
  dismiss: (id: string) => post(`/api/notifications/${encodeURIComponent(id)}`, { action: "dismiss" }),
  snooze: (id: string, until: string) =>
    post(`/api/notifications/${encodeURIComponent(id)}`, { action: "snooze", until }),
  readAll: () => post("/api/notifications/read-all"),
  archiveRead: () => post("/api/notifications/archive-read"),
  updatePrefs: async (patch: UpdatePrefsRequest): Promise<void> => {
    const res = await fetch("/api/notifications/prefs", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    if (!res.ok) throw new Error(`/api/notifications/prefs ${res.status}`);
  },
  // The route id is authoritative; only actionId + idempotencyKey travel in the
  // body. Returns the server's { status, doneLabel } so the UI can confirm.
  applyAction: async (input: {
    notificationId: string;
    actionId: string;
    idempotencyKey: string;
  }): Promise<ApplyActionResult> => {
    const res = await fetch(
      `/api/notifications/${encodeURIComponent(input.notificationId)}/actions/apply`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId: input.actionId, idempotencyKey: input.idempotencyKey })
      }
    );
    if (!res.ok) throw new Error(`apply-action ${res.status}`);
    return res.json();
  }
};
