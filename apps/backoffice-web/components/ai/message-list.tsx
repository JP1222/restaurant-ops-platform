"use client";

import { type UIMessage } from "ai";
import { type ReactNode } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ChatEmptyState } from "./chat-empty-state";
import { MessageBubble } from "./message-bubble";
import { type ReceiptBatchPart } from "./receipt-batch-part";

const MAX_RENDERED_MESSAGES = 50;

interface MessageListProps {
  messages: UIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  onApprove?: (id: string, approved: boolean) => void;
  renderReceiptBatch?: (messageId: string, part: ReceiptBatchPart) => ReactNode;
  onPrompt: (text: string) => void;
  onUploadReceipt: () => void;
}

export function MessageList({
  messages,
  status,
  onApprove,
  renderReceiptBatch,
  onPrompt,
  onUploadReceipt,
}: MessageListProps) {
  const visible = messages.slice(-MAX_RENDERED_MESSAGES);

  if (visible.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <ChatEmptyState onPrompt={onPrompt} onUploadReceipt={onUploadReceipt} />
      </div>
    );
  }

  return (
    <Conversation>
      <ConversationContent>
        {visible.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            streaming={status === "streaming" && index === visible.length - 1}
            onApprove={onApprove}
            renderReceiptBatch={renderReceiptBatch}
          />
        ))}
        {status === "submitted" ? (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="pulse-dot bg-muted-foreground inline-flex size-2 rounded-full" aria-hidden />
            Thinking...
          </div>
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
