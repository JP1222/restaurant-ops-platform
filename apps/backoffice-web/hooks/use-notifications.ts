"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { notificationsBff } from "@/lib/notifications/api";
import { useNotificationStore } from "@/stores/notifications";

// Hydrates the shared notification store from the BFF and keeps it fresh by
// polling. A 503 list means notifications-api isn't connected yet — the store
// stays on its sample seed (`live = false`), so the bell/inbox keep working.
// Once live, it also opens the realtime SSE stream so a producer event updates the
// bell at once instead of waiting for the next poll. Mounted once by
// <NotificationsBoot/> in the authed layout.
export function useNotificationsSync() {
  const hydrate = useNotificationStore((s) => s.hydrate);
  const hydratePrefs = useNotificationStore((s) => s.hydratePrefs);
  const setLive = useNotificationStore((s) => s.setLive);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["notifications", "list"],
    queryFn: () => notificationsBff.list(),
    refetchInterval: 30_000,
    staleTime: 15_000
  });

  const prefs = useQuery({
    queryKey: ["notifications", "prefs"],
    queryFn: () => notificationsBff.getPrefs(),
    staleTime: 60_000
  });

  useEffect(() => {
    if (list.data) hydrate(list.data.notifications);
    else if (list.data === null) setLive(false);
  }, [list.data, hydrate, setLive]);

  useEffect(() => {
    if (prefs.data) hydratePrefs(prefs.data);
  }, [prefs.data, hydratePrefs]);

  // Realtime: once live (notifications-api connected, list.data present), subscribe
  // to the BFF SSE stream and refetch the list the moment a producer fires — the
  // pushed frame is just a "something changed" signal, so the contract-typed list
  // query stays the one source of truth (no client-side DTO handling). The 30s poll
  // remains the fallback; EventSource reconnects on its own after a drop.
  const live = list.data != null;
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/notifications/stream", { withCredentials: true });
    const onNotification = () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications", "list"] });
    };
    es.addEventListener("notification", onNotification);
    return () => {
      es.removeEventListener("notification", onNotification);
      es.close();
    };
  }, [live, queryClient]);
}
