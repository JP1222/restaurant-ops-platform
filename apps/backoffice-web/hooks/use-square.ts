"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CatalogImportResult,
  SquareConnectRequest,
  SquareConnectResponse,
  SquareImportCatalogRequest,
  SquareTestConnectionResponse,
} from "@rop/contracts";

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
  // For Square routes we surface the error kind from the body rather than a
  // generic message so the wizard state machine can branch on it.
  const responseBody = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const kind = typeof responseBody["error"] === "string" ? responseBody["error"] : "upstream";
    const err = new Error(kind);
    (err as Error & { kind: string }).kind = kind;
    (err as Error & { status: number }).status = response.status;
    throw err;
  }
  return responseBody as T;
}

export function useTestSquareConnection() {
  return useMutation({
    mutationFn: (body: SquareConnectRequest) =>
      fetchJson<SquareTestConnectionResponse>("/api/square/test-connection", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

export function useConnectSquare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SquareConnectRequest) =>
      fetchJson<SquareConnectResponse>("/api/square/connect", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      // Invalidate locations so the store switcher reflects the new binding.
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      void queryClient.invalidateQueries({ queryKey: ["unlinked-merchants"] });
    },
  });
}

// Reads the bound store's live Square catalog and returns counts. `error.kind`
// carries the backend error kind (not_found / not_square / invalid_token /
// timeout / upstream) so callers can branch.
export function useImportSquareCatalog() {
  return useMutation({
    mutationFn: (body: SquareImportCatalogRequest) =>
      fetchJson<CatalogImportResult>("/api/square/import-catalog", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}
