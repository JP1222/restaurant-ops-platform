"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SelfProfileSchema, type SelfProfile } from "@rop/contracts";

const PROFILE_KEY = ["auth", "profile"] as const;
const STALE_MS = 60_000;

// Session-scoped self profile. The account is always the cookie's — there is no
// id in the request. Role is READ-ONLY and there is no email channel.
export function useProfile() {
  return useQuery<SelfProfile>({
    queryKey: PROFILE_KEY,
    queryFn: async () => {
      const response = await fetch("/api/auth/profile", {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (response.status === 401) {
        throw new Error("Your session has expired — sign in again.");
      }
      if (!response.ok) {
        throw new Error("Could not load your profile.");
      }
      return SelfProfileSchema.parse(await response.json());
    },
    staleTime: STALE_MS
  });
}

// Self-edit of displayName only. Returns the same SelfProfile shape; the cache
// is invalidated on success so the role badge and passkey count stay fresh.
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation<SelfProfile, Error, { displayName: string }>({
    mutationFn: async (body) => {
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
      });
      if (response.status === 401) {
        throw new Error("Your session has expired — sign in again.");
      }
      if (!response.ok) {
        throw new Error("Could not update your profile.");
      }
      return SelfProfileSchema.parse(await response.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_KEY })
  });
}
