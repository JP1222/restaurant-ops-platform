"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { registerPasskey } from "@rop/auth/client";
import type { AdminUserPasskey, AdminUserPasskeyListResponse } from "@rop/contracts";

const PASSKEYS_KEY = ["auth", "passkeys"] as const;
const PROFILE_KEY = ["auth", "profile"] as const;
const STALE_MS = 60_000;

// Human copy for the lockout guard the DELETE route returns as a 409 with
// `{ error: "last_login_method", message }`. We surface the route's message
// when present and fall back to a stable string so the UI never renders a raw
// machine code.
const LAST_LOGIN_METHOD_FALLBACK =
  "This is your only sign-in method — set a password or add another passkey first.";

// List the SESSION account's own passkeys. Session-scoped: no id in the request.
export function useSelfPasskeys() {
  return useQuery<AdminUserPasskey[]>({
    queryKey: PASSKEYS_KEY,
    queryFn: async () => {
      const response = await fetch("/api/auth/passkeys", {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (response.status === 401) {
        throw new Error("Your session has expired — sign in again.");
      }
      if (!response.ok) {
        throw new Error("Could not load your passkeys.");
      }
      const body = (await response.json()) as AdminUserPasskeyListResponse;
      return body.passkeys;
    },
    staleTime: STALE_MS
  });
}

// Run the browser WebAuthn registration ceremony against the BFF
// /api/auth/passkeys/registration/{options,verify} routes via the shared client
// helper, then refresh the list + profile (passkeyCount) on success.
export function useAddSelfPasskey() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      await registerPasskey();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      queryClient.invalidateQueries({ queryKey: PROFILE_KEY });
    }
  });
}

// Remove one of the session account's own passkeys. The lockout guard returns a
// 409 whose message we surface verbatim so the operator sees the human copy.
export function useRemoveSelfPasskey() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (credentialId) => {
      const response = await fetch(
        `/api/auth/passkeys/${encodeURIComponent(credentialId)}`,
        { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } }
      );
      if (response.ok) {
        return;
      }
      if (response.status === 401) {
        throw new Error("Your session has expired — sign in again.");
      }
      const body = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (response.status === 409 && body?.error === "last_login_method") {
        throw new Error(body.message || LAST_LOGIN_METHOD_FALLBACK);
      }
      if (response.status === 404) {
        throw new Error("That passkey was already removed.");
      }
      throw new Error(body?.message || body?.error || "Could not remove the passkey.");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
      queryClient.invalidateQueries({ queryKey: PROFILE_KEY });
    }
  });
}
