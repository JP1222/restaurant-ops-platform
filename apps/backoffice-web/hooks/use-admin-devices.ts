"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  KdsDeviceCreateRequest,
  KdsDeviceCreateResponse,
  KdsDeviceListResponse,
  KdsDevicePairCreateRequest,
  KdsDevicePairCreateResponse
} from "@rop/contracts";

const ADMIN_DEVICES_STALE_MS = 30_000;
const QUERY_KEY = ["admin", "devices"] as const;

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

export function useAdminDevices() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<KdsDeviceListResponse>("/api/admin/devices"),
    staleTime: ADMIN_DEVICES_STALE_MS,
    refetchInterval: ADMIN_DEVICES_STALE_MS
  });
}

export function useCreateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: KdsDeviceCreateRequest) =>
      fetchJson<KdsDeviceCreateResponse>("/api/admin/devices", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}

export function useCreatePairing() {
  // No query invalidation: generating a claim does NOT create a device row —
  // the row is minted when the device redeems the code (kds-api side). The list
  // auto-refetches on its 30s interval, so a freshly paired device appears then.
  return useMutation({
    mutationFn: (body: KdsDevicePairCreateRequest) =>
      fetchJson<KdsDevicePairCreateResponse>("/api/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify(body)
      })
  });
}

export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      fetchJson<{ ok: true }>(`/api/admin/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE"
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}
