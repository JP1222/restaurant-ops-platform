"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminUserCreateRequest,
  AdminUserCreateResponse,
  AdminUserErrorCode,
  AdminUserListResponse,
  AdminUserPasskeyListResponse,
  AdminUserPasswordResetResponse,
  AdminUserUpdateRequest,
  AdminUserUpdateResponse
} from "@rop/contracts";

const USERS_KEY = ["admin", "users"] as const;
const PASSKEYS_KEY = (userId: string) => ["admin", "users", userId, "passkeys"] as const;

const STALE_MS = 60_000;

// Maps the kds-api machine error codes (surfaced by the BFF as
// { error: "upstream_error", upstream: { error: <code> } }) to operator-facing
// copy. The raw code is preserved on the thrown Error's `code` field for logs;
// the UI renders `message` and never the raw envelope.
const ERROR_COPY: Record<AdminUserErrorCode, string> = {
  last_admin: "You can't delete the only account.",
  last_owner: "At least one Owner must remain.",
  last_login_method:
    "This is the account's only sign-in method — set a password or add another passkey first.",
  username_taken: "That username is already taken.",
  user_not_found: "That account no longer exists.",
  passkey_not_found: "That passkey was already removed."
};

export class AdminUsersError extends Error {
  readonly code?: AdminUserErrorCode;
  readonly status: number;
  constructor(message: string, status: number, code?: AdminUserErrorCode) {
    super(message);
    this.name = "AdminUsersError";
    this.status = status;
    this.code = code;
  }
}

function isErrorCode(value: unknown): value is AdminUserErrorCode {
  return value === "last_admin" || value === "last_owner" || value === "last_login_method" ||
    value === "username_taken" || value === "user_not_found" || value === "passkey_not_found";
}

// Pull the machine error code out of the BFF envelope shapes:
// { upstream: { error: <code> } } (4xx pass-through) or a bare { error: <code> }.
function extractErrorCode(body: unknown): AdminUserErrorCode | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const upstream = record.upstream;
  if (typeof upstream === "object" && upstream !== null) {
    const nested = (upstream as Record<string, unknown>).error;
    if (isErrorCode(nested)) return nested;
  }
  if (isErrorCode(record.error)) return record.error;
  return undefined;
}

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
    throw new AdminUsersError("Your session has expired — sign in again.", 401);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = extractErrorCode(body);
    const message = code ? ERROR_COPY[code] : "Something went wrong. Please try again.";
    throw new AdminUsersError(message, response.status, code);
  }

  return response.json() as Promise<T>;
}

export function useAdminUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => fetchJson<AdminUserListResponse>("/api/admin/users"),
    staleTime: STALE_MS,
    refetchInterval: STALE_MS
  });
}

export function useCreateAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminUserCreateRequest) =>
      fetchJson<AdminUserCreateResponse>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY })
  });
}

export function useUpdateAdminUser(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminUserUpdateRequest) =>
      fetchJson<AdminUserUpdateResponse>(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY })
  });
}

export function useDeleteAdminUser(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson<{ ok: true }>(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE"
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY })
  });
}

export function useResetAdminUserPassword(userId: string) {
  return useMutation({
    mutationFn: () =>
      fetchJson<AdminUserPasswordResetResponse>(
        `/api/admin/users/${encodeURIComponent(userId)}/password`,
        { method: "POST" }
      )
  });
}

export function useUserPasskeys(userId: string | null) {
  return useQuery({
    queryKey: userId ? PASSKEYS_KEY(userId) : ["admin", "users", "_none", "passkeys"],
    queryFn: () =>
      fetchJson<AdminUserPasskeyListResponse>(
        `/api/admin/users/${encodeURIComponent(userId ?? "")}/passkeys`
      ),
    enabled: Boolean(userId),
    staleTime: STALE_MS
  });
}

export function useRevokeUserPasskey(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentialId: string) =>
      fetchJson<{ ok: true }>(
        `/api/admin/users/${encodeURIComponent(userId)}/passkeys/${encodeURIComponent(credentialId)}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY(userId) });
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
    }
  });
}
