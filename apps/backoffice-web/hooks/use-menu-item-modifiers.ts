"use client";

import { useQuery } from "@tanstack/react-query";
import type { ItemModifierRow } from "@/lib/analytics-api/types";
import {
  transformMenuModifiers,
  type MenuModifier
} from "@/lib/analytics-api/menu-modifiers-transform";

const STALE_MS = 60_000;

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

interface MenuItemModifiersResponse {
  item_fingerprint: string;
  days: number;
  line_count: number | string;
  modifiers: ItemModifierRow[];
}

export function useMenuItemModifiers(fingerprint: string | null, days = 30) {
  return useQuery({
    queryKey: ["menu-item-modifiers", fingerprint, days],
    queryFn: async (): Promise<MenuModifier[]> => {
      const raw = await fetchJson<MenuItemModifiersResponse>(
        `/api/menu/items/${encodeURIComponent(fingerprint!)}/modifiers?days=${days}`
      );
      return transformMenuModifiers(raw.modifiers);
    },
    enabled: fingerprint != null && fingerprint.length > 0,
    staleTime: STALE_MS
  });
}
