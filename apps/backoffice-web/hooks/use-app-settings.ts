"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppSettingListResponse, SettingKey } from "@rop/contracts";
import type { SaveStatus } from "@/components/settings/status-pill";

const QUERY_KEY = ["app-settings"] as const;
const STALE_MS = 60_000;
const SAVED_CLEAR_MS = 1_900;
const ERROR_CLEAR_MS = 3_200;

/**
 * Error carrying the HTTP status + parsed body so callers can branch on a 409
 * conflict (issue #177) without re-parsing a sliced string message.
 */
export class SettingsRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "SettingsRequestError";
    this.status = status;
    this.body = body;
  }
}

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
  if (response.status === 401) throw new SettingsRequestError(401, null, "unauthenticated");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    throw new SettingsRequestError(
      response.status,
      body,
      `${url} ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return response.json() as Promise<T>;
}

export function useAppSettings() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchJson<AppSettingListResponse>("/api/settings"),
    staleTime: STALE_MS,
  });
}

export interface UpdateSettingArgs {
  key: SettingKey;
  value: unknown;
}

interface SaveContext {
  previous?: AppSettingListResponse;
}

/**
 * Optimistic, per-field settings save.
 *
 * - `onMutate` writes the new value into the cache immediately and snapshots
 *   the previous list, so the UI reflects the change without waiting on the PUT.
 * - `onError` restores the snapshot (rollback), flags the row, and toasts.
 * - `onSettled` invalidates so a success re-reads the server: `source` flips to
 *   `db` and `updatedAt`/`updatedBy` refresh.
 *
 * Status is tracked per setting key (not a single global flag) so saving one
 * row never disables the others. `status(key)` returns the current lifecycle,
 * auto-clearing after success/error.
 */
export function useSettingsSave() {
  const queryClient = useQueryClient();
  const [statusMap, setStatusMap] = useState<Partial<Record<SettingKey, SaveStatus>>>({});
  const timers = useRef<Partial<Record<SettingKey, ReturnType<typeof setTimeout>>>>({});

  const scheduleClear = useCallback((key: SettingKey, after: number) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      setStatusMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, after);
  }, []);

  const mutation = useMutation<{ ok: true }, Error, UpdateSettingArgs, SaveContext>({
    mutationFn: (args) => {
      // Optimistic last-write-wins (issue #177): send the version we last read
      // for this key so the BFF can 409 a clobbering save. Read it from the
      // cache at mutate time (post-`onMutate` the cache holds the optimistic
      // row, but `version` is only refreshed on a server re-read, so this is the
      // last server-confirmed version). A missing row means "no DB row yet"
      // (version 0); send undefined to keep an unconditional write for the very
      // first save so a fresh key doesn't false-conflict.
      const current = queryClient.getQueryData<AppSettingListResponse>(QUERY_KEY);
      const row = current?.settings.find((s) => s.key === args.key);
      const ifVersion = row && row.source === "db" ? row.version : undefined;
      return fetchJson<{ ok: true }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ key: args.key, value: args.value, ifVersion }),
      });
    },
    onMutate: async ({ key, value }) => {
      clearTimeout(timers.current[key]);
      setStatusMap((prev) => ({ ...prev, [key]: "saving" }));
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const previous = queryClient.getQueryData<AppSettingListResponse>(QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<AppSettingListResponse>(QUERY_KEY, {
          settings: previous.settings.map((s) => (s.key === key ? { ...s, value } : s)),
        });
      }
      return { previous };
    },
    onError: (error, { key }, context) => {
      if (context?.previous) queryClient.setQueryData(QUERY_KEY, context.previous);
      setStatusMap((prev) => ({ ...prev, [key]: "error" }));
      scheduleClear(key, ERROR_CLEAR_MS);
      // Conflict (issue #177): someone else saved this key first. Tell the user
      // their edit was NOT applied and prompt a reload, rather than the generic
      // "reverted" copy. `onSettled`'s invalidate re-reads the live value.
      if (error instanceof SettingsRequestError && error.status === 409) {
        toast.error("Someone else changed this setting — reload to see the latest, then re-apply.");
        return;
      }
      toast.error("Couldn't save — change reverted");
    },
    onSuccess: (_data, { key }) => {
      setStatusMap((prev) => ({ ...prev, [key]: "saved" }));
      scheduleClear(key, SAVED_CLEAR_MS);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const update = useCallback(
    (key: SettingKey, value: unknown) => {
      mutation.mutate({ key, value });
    },
    [mutation]
  );

  // Awaitable variant for flows that must know the outcome (e.g. the secret
  // rotate dialog, which only clears its input on a confirmed save).
  const updateAsync = useCallback(
    (key: SettingKey, value: unknown) => mutation.mutateAsync({ key, value }),
    [mutation]
  );

  const status = useCallback((key: SettingKey): SaveStatus | null => statusMap[key] ?? null, [statusMap]);

  return { update, updateAsync, status };
}
