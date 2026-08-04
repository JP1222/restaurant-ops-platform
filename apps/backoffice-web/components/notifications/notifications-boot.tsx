"use client";

import { useNotificationsSync } from "@/hooks/use-notifications";

// Headless: runs the store↔BFF sync once, under the authed layout's QueryProvider.
export function NotificationsBoot() {
  useNotificationsSync();
  return null;
}
