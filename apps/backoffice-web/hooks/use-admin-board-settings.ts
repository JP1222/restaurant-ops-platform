"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KitchenBoardSettings } from "@rop/contracts";

interface BoardSettingsResponse {
  merchantId: string;
  settings: KitchenBoardSettings;
}

const QUERY_KEY = ["admin", "board-settings"] as const;
const STALE_MS = 60_000;

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });

  if (response.status === 401) {
    throw new Error("unauthenticated");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

export function useAdminBoardSettings() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<BoardSettingsResponse>("/api/admin/board-settings"),
    staleTime: STALE_MS
  });
}

export function useUpdateBoardSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: KitchenBoardSettings) =>
      fetchJson<BoardSettingsResponse>("/api/admin/board-settings", {
        method: "PUT",
        body: JSON.stringify(settings)
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(QUERY_KEY, response);
    }
  });
}
