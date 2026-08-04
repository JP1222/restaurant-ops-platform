"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  InventoryEmployeeCreateRequest,
  InventoryEmployeeListResponse,
  InventoryEmployeePinResetRequest,
  InventoryEmployeeResponse,
  InventoryEmployeeUpdateRequest,
  InventorySecuritySettings,
  InventorySecuritySettingsSave
} from "@rop/contracts";

const CREW_KEY = ["inventory", "crew"] as const;
const CREW_SECURITY_KEY = ["inventory", "crew", "security"] as const;
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
  if (response.status === 409) {
    throw new Error("PIN already in use");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

export function useCrew() {
  return useQuery({
    queryKey: CREW_KEY,
    queryFn: () => fetchJson<InventoryEmployeeListResponse>("/api/inventory/crew"),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}

export function useCreateCrew() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryEmployeeCreateRequest) =>
      fetchJson<InventoryEmployeeResponse>("/api/inventory/crew", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREW_KEY })
  });
}

export function useUpdateCrew(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryEmployeeUpdateRequest) =>
      fetchJson<InventoryEmployeeResponse>(`/api/inventory/crew/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREW_KEY })
  });
}

export function useResetCrewPin(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventoryEmployeePinResetRequest) =>
      fetchJson<InventoryEmployeeResponse>(`/api/inventory/crew/${encodeURIComponent(id)}/pin`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREW_KEY })
  });
}

export function useCrewSecurity() {
  return useQuery({
    queryKey: CREW_SECURITY_KEY,
    queryFn: () => fetchJson<InventorySecuritySettings>("/api/inventory/crew/security"),
    staleTime: STALE_MS
  });
}

export function useSaveCrewSecurity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InventorySecuritySettingsSave) =>
      fetchJson<InventorySecuritySettings>("/api/inventory/crew/security", {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREW_SECURITY_KEY })
  });
}
