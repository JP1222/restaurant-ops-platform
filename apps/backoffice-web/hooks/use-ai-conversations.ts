"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AiConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCallCount: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface AiConversationDetail extends AiConversationSummary {
  messages: AiConversationMessage[];
}

const LIST_KEY = ["ai", "conversations"] as const;
const DETAIL_KEY = (id: string) => ["ai", "conversations", id] as const;
const STALE_MS = 60_000;

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  if (response.status === 401) {
    throw new Error("unauthenticated");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${url} ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export function useAiConversations(limit?: number) {
  const query = typeof limit === "number"
    ? `?limit=${encodeURIComponent(String(limit))}`
    : "";
  return useQuery({
    queryKey: [...LIST_KEY, limit ?? null],
    queryFn: () =>
      fetchJson<{ conversations: AiConversationSummary[] }>(
        `/api/ai/conversations${query}`,
      ),
    staleTime: STALE_MS,
  });
}

export function useAiConversation(id: string | null) {
  return useQuery({
    queryKey: id ? DETAIL_KEY(id) : ["ai", "conversations", "_none"],
    queryFn: () =>
      fetchJson<{ conversation: AiConversationDetail }>(
        `/api/ai/conversations/${encodeURIComponent(id ?? "")}`,
      ),
    enabled: Boolean(id),
    staleTime: STALE_MS,
  });
}

export function useDeleteAiConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: true }>(`/api/ai/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: LIST_KEY });
      queryClient.removeQueries({ queryKey: DETAIL_KEY(id) });
    },
  });
}
