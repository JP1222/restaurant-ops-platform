"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Maximize,
  MessageSquarePlus,
  PanelRight,
  PictureInPicture2,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAiAssistantStore, type AiLayoutMode } from "@/stores/ai-assistant";
import { ChatPane } from "./chat-pane";
import { ConversationHistoryPanel } from "./conversation-history-panel";

const LAYOUTS: { mode: AiLayoutMode; label: string; Icon: LucideIcon }[] = [
  { mode: "floating", label: "Floating", Icon: PictureInPicture2 },
  { mode: "sidebar", label: "Sidebar", Icon: PanelRight },
  { mode: "fullscreen", label: "Full screen", Icon: Maximize },
];

export function AiFab() {
  const isOpen = useAiAssistantStore((s) => s.isOpen);
  const mode = useAiAssistantStore((s) => s.mode);
  const openAssistant = useAiAssistantStore((s) => s.open);
  const closeAssistant = useAiAssistantStore((s) => s.close);
  const setMode = useAiAssistantStore((s) => s.setMode);
  const newChat = useAiAssistantStore((s) => s.newChat);

  const [entering, setEntering] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasOpen = useRef(isOpen);

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setEntering(true);
      if (enterTimer.current) clearTimeout(enterTimer.current);
      enterTimer.current = setTimeout(() => setEntering(false), 300);
    }
    wasOpen.current = isOpen;
    return () => {
      if (enterTimer.current) clearTimeout(enterTimer.current);
    };
  }, [isOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (useAiAssistantStore.getState().isOpen) closeAssistant();
        else openAssistant();
        return;
      }
      if (event.key === "Escape" && useAiAssistantStore.getState().isOpen) {
        if (layoutMenuOpen) {
          setLayoutMenuOpen(false);
          return;
        }
        closeAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAssistant, closeAssistant, layoutMenuOpen]);

  return (
    <>
      {!isOpen ? (
        <Button
          size="icon"
          onClick={() => openAssistant()}
          className="shadow-(--shadow-lift) fixed right-6 bottom-6 z-40 size-12 rounded-full transition-transform hover:-translate-y-0.5 active:scale-95"
          aria-label="Open AI assistant"
          title="AI Assistant · ⌘J"
        >
          <Sparkles className="size-[22px]" />
          <span
            className="border-background bg-accent absolute right-0.5 top-0.5 size-2.5 rounded-full border-2"
            aria-hidden
          />
        </Button>
      ) : null}

      {isOpen && mode === "fullscreen" ? (
        <div className="ai-scrim" onClick={() => closeAssistant()} aria-hidden />
      ) : null}

      <section
        className="ai-panel"
        data-mode={mode}
        data-entering={entering ? "true" : "false"}
        style={{ display: isOpen ? "flex" : "none" }}
        role="dialog"
        aria-label="AI assistant"
      >
        <header className="flex h-12 flex-none items-center gap-1 border-b pr-1.5 pl-3.5">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="text-accent size-[18px]" aria-hidden />
            AI Assistant
          </span>
          <span className="flex-1" />

          <ConversationHistoryPanel />

          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-8"
            aria-label="New chat"
            title="New chat"
            onClick={() => newChat()}
          >
            <MessageSquarePlus data-icon />
          </Button>

          <DropdownMenu open={layoutMenuOpen} onOpenChange={setLayoutMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground size-8"
                aria-label="Change layout"
                title="Layout"
              >
                <PanelRight data-icon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {LAYOUTS.map(({ mode: layoutMode, label, Icon }) => (
                <DropdownMenuItem
                  key={layoutMode}
                  onSelect={() => setMode(layoutMode)}
                  className="gap-2.5"
                >
                  <Icon className="text-muted-foreground size-4" />
                  <span className="flex-1">{label}</span>
                  {mode === layoutMode ? <Check className="text-accent size-4" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-8"
            aria-label="Close AI assistant"
            title="Close"
            onClick={() => closeAssistant()}
          >
            <X data-icon />
          </Button>
        </header>

        <ChatPane />
      </section>
    </>
  );
}
