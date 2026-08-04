"use client";

import {
  Camera,
  ChevronRight,
  LayoutDashboard,
  Sparkles,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { Suggestion } from "@/components/ai-elements/suggestion";
import { cn } from "@/lib/utils";

interface SuggestionItem {
  label: string;
  Icon: LucideIcon;
  accent?: boolean;
  prompt?: string;
}

const SUGGESTIONS: SuggestionItem[] = [
  { label: "Update stock from a receipt photo", Icon: Camera, accent: true },
  { label: "What's running low?", Icon: TriangleAlert, prompt: "What's running low?" },
  { label: "What does today look like?", Icon: LayoutDashboard, prompt: "What does today look like?" },
  { label: "Log waste from the line", Icon: Trash2, prompt: "Log waste from the line" },
];

interface ChatEmptyStateProps {
  onPrompt: (text: string) => void;
  onUploadReceipt: () => void;
}

export function ChatEmptyState({ onPrompt, onUploadReceipt }: ChatEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
      <Sparkles className="text-accent mb-1 size-6" aria-hidden />
      <h3 className="text-base font-semibold">Ask anything about your restaurant data</h3>
      <p className="text-muted-foreground max-w-[34ch] text-sm leading-relaxed">
        Try &ldquo;What&rsquo;s running low?&rdquo;, send a receipt photo to update stock, or log
        waste.
      </p>
      <div className="mt-4 flex w-full max-w-[340px] flex-col gap-2">
        {SUGGESTIONS.map((item) => (
          <Suggestion
            key={item.label}
            suggestion={item.label}
            variant="outline"
            onClick={() => (item.prompt ? onPrompt(item.prompt) : onUploadReceipt())}
            className="h-auto w-full justify-start gap-2.5 rounded-lg px-3 py-2.5 text-sm font-normal"
          >
            <item.Icon
              className={cn("size-4 shrink-0", item.accent ? "text-accent" : "text-muted-foreground")}
            />
            <span className="flex-1 truncate text-left">{item.label}</span>
            <ChevronRight className="size-3.5 shrink-0 opacity-40" />
          </Suggestion>
        ))}
      </div>
    </div>
  );
}
