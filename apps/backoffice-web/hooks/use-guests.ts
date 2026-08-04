"use client";

import { useQuery } from "@tanstack/react-query";
import type { LoyaltyCohortsResponse } from "@rop/contracts";

// `null` is the honest "crm-api not connected yet" state (BFF answered 503), kept
// distinct from a genuine error so the page shows a wiring hint, not a failure.
export type GuestsResult = LoyaltyCohortsResponse | null;

async function fetchGuests(): Promise<GuestsResult> {
  const res = await fetch("/api/guests", { credentials: "include" });
  if (res.status === 503) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/api/guests ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<LoyaltyCohortsResponse>;
}

export function useGuests() {
  return useQuery({
    queryKey: ["guests", "cohorts"],
    queryFn: fetchGuests,
    staleTime: 60_000,
  });
}
