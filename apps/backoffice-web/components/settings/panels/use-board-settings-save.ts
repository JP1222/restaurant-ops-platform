"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { KitchenBoardSettings } from "@rop/contracts";
import type { SaveStatus } from "@/components/settings/status-pill";

const QUERY_KEY = ["admin", "board-settings"] as const;
const SAVED_CLEAR_MS = 1_900;
const ERROR_CLEAR_MS = 3_200;

interface BoardSettingsResponse {
  merchantId: string;
  settings: KitchenBoardSettings;
}

async function putBoardSettings(settings: KitchenBoardSettings): Promise<BoardSettingsResponse> {
  const res = await fetch("/api/admin/board-settings", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`board-settings ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<BoardSettingsResponse>;
}

/**
 * Per-field optimistic save for KitchenBoardSettings. The board API is a single
 * whole-object PUT, so each field change PUTs the full (patched) object; status
 * is tracked per field key for the StatusPill — no global disable — with
 * rollback + toast on failure. Mirrors useSettingsSave, adapted to the
 * whole-object board endpoint.
 */
export function useBoardSettingsSave(merchantId: string) {
  const queryClient = useQueryClient();
  const [statusMap, setStatusMap] = useState<Record<string, SaveStatus>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const scheduleClear = useCallback((key: string, after: number) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      setStatusMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, after);
  }, []);

  const mutation = useMutation<
    BoardSettingsResponse,
    Error,
    { key: string; next: KitchenBoardSettings },
    { previous?: BoardSettingsResponse }
  >({
    mutationFn: ({ next }) => putBoardSettings(next),
    onMutate: async ({ key, next }) => {
      clearTimeout(timers.current[key]);
      setStatusMap((prev) => ({ ...prev, [key]: "saving" }));
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const previous = queryClient.getQueryData<BoardSettingsResponse>(QUERY_KEY);
      queryClient.setQueryData<BoardSettingsResponse>(QUERY_KEY, { merchantId, settings: next });
      return { previous };
    },
    onError: (_error, { key }, context) => {
      if (context?.previous) queryClient.setQueryData(QUERY_KEY, context.previous);
      setStatusMap((prev) => ({ ...prev, [key]: "error" }));
      scheduleClear(key, ERROR_CLEAR_MS);
      toast.error("Couldn't save — change reverted");
    },
    onSuccess: (response, { key }) => {
      queryClient.setQueryData(QUERY_KEY, response);
      setStatusMap((prev) => ({ ...prev, [key]: "saved" }));
      scheduleClear(key, SAVED_CLEAR_MS);
    },
  });

  const save = useCallback(
    (key: string, next: KitchenBoardSettings) => {
      mutation.mutate({ key, next });
    },
    [mutation]
  );

  const status = useCallback((key: string): SaveStatus | null => statusMap[key] ?? null, [statusMap]);

  return { save, status };
}
