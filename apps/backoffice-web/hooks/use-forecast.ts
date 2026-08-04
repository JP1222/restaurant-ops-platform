"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ForecastResponse, ForecastRunResult } from "@/lib/analytics-api/types";

const STALE_MS = 60_000;

async function fetchForecast(): Promise<ForecastResponse> {
  const response = await fetch("/api/forecast", { credentials: "include" });
  if (response.status === 401) throw new Error("unauthenticated");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/forecast ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json() as Promise<ForecastResponse>;
}

/** The stored demand forecast (curve + prediction band + the model's own backtest). */
export function useForecast() {
  return useQuery({ queryKey: ["forecast"], queryFn: fetchForecast, staleTime: STALE_MS });
}

async function postRunForecast(): Promise<ForecastRunResult> {
  const response = await fetch("/api/forecast", { method: "POST", credentials: "include" });
  if (response.status === 401) throw new Error("unauthenticated");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`/api/forecast ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json() as Promise<ForecastRunResult>;
}

/** Recompute the forecast; invalidates the forecast query so the curve refreshes. */
export function useRunForecast() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postRunForecast,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["forecast"] }),
  });
}
