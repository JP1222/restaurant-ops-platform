"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StoreLocation,
  StoreLocationCreate,
  StoreLocationListResponse,
  UnlinkedMerchantListResponse,
} from "@rop/contracts";

const QUERY_KEY = ["locations"] as const;
const UNLINKED_MERCHANTS_KEY = ["unlinked-merchants"] as const;
const STALE_MS = 60_000;

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401) throw new Error("unauthenticated");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export function useLocations() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<StoreLocationListResponse>("/api/locations"),
    staleTime: STALE_MS,
  });
}

export interface RenameLocationArgs {
  id: string;
  name: string;
}

export function useRenameLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: RenameLocationArgs) =>
      fetchJson<{ location: StoreLocation }>(`/api/locations/${encodeURIComponent(args.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: args.name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useCreateLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: StoreLocationCreate) =>
      fetchJson<{ location: StoreLocation }>("/api/locations", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

// Connected POS store-accounts not yet bound to a store, for the "Bind POS"
// picker. Refetched only while the bind dialog is open (the caller can gate it
// with `enabled`).
export function useUnlinkedMerchants(enabled = true) {
  return useQuery({
    queryKey: UNLINKED_MERCHANTS_KEY,
    queryFn: () =>
      fetchJson<UnlinkedMerchantListResponse>("/api/locations/unlinked-merchants"),
    staleTime: STALE_MS,
    enabled,
  });
}

export interface BindMerchantArgs {
  locationId: string;
  merchantId: string;
}

export function useBindMerchant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: BindMerchantArgs) =>
      fetchJson<{ location: StoreLocation }>(
        `/api/locations/${encodeURIComponent(args.locationId)}/bind`,
        { method: "POST", body: JSON.stringify({ merchantId: args.merchantId }) },
      ),
    onSuccess: () => {
      // The store is now bound and the merchant is no longer unlinked.
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: UNLINKED_MERCHANTS_KEY });
    },
  });
}
