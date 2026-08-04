"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DeliverectIntegrationConfig,
  DeliverectIntegrationResponse,
  DeliverectIntegrationUpdateRequest
} from "@rop/contracts";

const QUERY_KEY = ["admin", "integrations", "deliverect"] as const;
const STALE_MS = 60_000;

export class DeliverectNotConfiguredError extends Error {
  constructor() {
    super("not_configured");
    this.name = "DeliverectNotConfiguredError";
  }
}

async function fetchConfig(): Promise<DeliverectIntegrationConfig | null> {
  const response = await fetch("/api/admin/integrations/deliverect", {
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (response.status === 401) {
    throw new Error("unauthenticated");
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/admin/integrations/deliverect ${response.status}: ${body.slice(0, 200)}`);
  }
  const payload = (await response.json()) as DeliverectIntegrationResponse;
  return payload.config;
}

async function updateConfig(
  body: DeliverectIntegrationUpdateRequest
): Promise<DeliverectIntegrationConfig> {
  const response = await fetch("/api/admin/integrations/deliverect", {
    method: "PUT",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PUT /api/admin/integrations/deliverect ${response.status}: ${text.slice(0, 200)}`);
  }
  const payload = (await response.json()) as DeliverectIntegrationResponse;
  return payload.config;
}

export function useAdminDeliverectIntegration() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchConfig,
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}

export function useUpdateDeliverectIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateConfig,
    onSuccess: (config) => {
      queryClient.setQueryData(QUERY_KEY, config);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  });
}
