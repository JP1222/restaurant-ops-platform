"use client";

import { useQuery } from "@tanstack/react-query";
import type { CloverIntegrationResponse } from "@rop/contracts";

const QUERY_KEY = ["admin", "integrations", "clover"] as const;
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

export function useAdminCloverIntegration() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<CloverIntegrationResponse>("/api/admin/integrations/clover"),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}
