"use client";

// Vendored from Vercel AI Elements (MIT) — registry network access is blocked in
// this environment, so the components are checked in and re-pointed at our own
// shadcn aliases (@/components/ui/*, @/lib/utils). Trimmed to the parts the
// assistant uses: the StickToBottom conversation wrapper, its content slot, and
// the "scroll to latest" affordance. StickToBottom gives robust streaming-safe
// auto-scroll (the message-vanishing/jank fix).

import type { ComponentProps } from "react";
import { useCallback } from "react";
import { ArrowDown } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps) {
  return (
    <StickToBottom
      className={cn("relative min-h-0 flex-1 overflow-y-auto", className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return <StickToBottom.Content className={cn("flex flex-col gap-4 p-4", className)} {...props} />;
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      aria-label="Scroll to latest"
      className={cn(
        "absolute bottom-3 left-1/2 size-8 -translate-x-1/2 rounded-full shadow-md",
        className,
      )}
      onClick={handleScrollToBottom}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDown className="size-4" />
    </Button>
  );
}
