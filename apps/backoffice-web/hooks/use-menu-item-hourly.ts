"use client";

import { useQuery } from "@tanstack/react-query";
import type { ItemHourlyRow } from "@/lib/analytics-api/types";
import type { DaypartsView } from "@/lib/analytics-api/dayparts-transform";
import { transformItemToHeatmap } from "@/lib/analytics-api/item-hourly-transform";

const STALE_MS = 60_000;
// Per-item heatmaps need ~8 weeks of history to populate enough weekday-hour
// cells for rare items. Tighter windows leave most cells empty.
const DEFAULT_DAYS = 56;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

interface MenuItemHourlyResponse {
  item_fingerprint: string;
  days: number;
  rows: ItemHourlyRow[];
}

export function useMenuItemHourly(fingerprint: string | null, days = DEFAULT_DAYS) {
  return useQuery({
    queryKey: ["menu-item-hourly", fingerprint, days],
    queryFn: async (): Promise<DaypartsView | null> => {
      const raw = await fetchJson<MenuItemHourlyResponse>(
        `/api/menu/items/${encodeURIComponent(fingerprint!)}/hourly?days=${days}`
      );
      return transformItemToHeatmap(raw.rows);
    },
    enabled: fingerprint != null && fingerprint.length > 0,
    staleTime: STALE_MS
  });
}
