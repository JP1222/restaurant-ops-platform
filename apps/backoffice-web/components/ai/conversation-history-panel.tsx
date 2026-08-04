"use client";

import { History, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useAiConversations,
  useDeleteAiConversation,
  type AiConversationSummary,
} from "@/hooks/use-ai-conversations";
import { useAiAssistantStore } from "@/stores/ai-assistant";
import { cn } from "@/lib/utils";

interface ConversationHistoryPanelProps {
  onPick?: (conversationId: string | null) => void;
}

export function ConversationHistoryPanel({ onPick }: ConversationHistoryPanelProps) {
  const selectConversation = useAiAssistantStore((s) => s.selectConversation);
  const conversationId = useAiAssistantStore((s) => s.conversationId);
  const { data, isLoading, error } = useAiConversations();
  const del = useDeleteAiConversation();

  const conversations: AiConversationSummary[] = data?.conversations ?? [];

  const handlePick = (id: string | null) => {
    selectConversation(id);
    onPick?.(id);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Conversation history"
          data-testid="ai-history-trigger"
        >
          <History data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="ai-history-popover">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Recent</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handlePick(null)}
            data-testid="ai-history-new"
          >
            New chat
          </Button>
        </div>
        {isLoading ? (
          <div className="text-muted-foreground p-4 text-sm">Loading...</div>
        ) : null}
        {error ? (
          <div className="text-destructive p-4 text-sm" role="alert">
            {error instanceof Error ? error.message : "Failed to load"}
          </div>
        ) : null}
        {!isLoading && !error && conversations.length === 0 ? (
          <div className="text-muted-foreground p-4 text-sm">No past chats yet.</div>
        ) : null}
        <ul className="max-h-80 overflow-y-auto">
          {conversations.map((conv) => {
            const isActive = conv.id === conversationId;
            return (
              <li
                key={conv.id}
                className={cn(
                  "group hover:bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-2 text-sm",
                  isActive && "bg-muted/40",
                )}
                data-testid="ai-history-row"
              >
                <button
                  type="button"
                  className="flex-1 truncate text-left"
                  onClick={() => handlePick(conv.id)}
                  aria-current={isActive ? "true" : undefined}
                >
                  {conv.title}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${conv.title}`}
                  onClick={() => del.mutate(conv.id)}
                  className="opacity-0 group-hover:opacity-100"
                  disabled={del.isPending}
                >
                  <Trash2 data-icon />
                </Button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
