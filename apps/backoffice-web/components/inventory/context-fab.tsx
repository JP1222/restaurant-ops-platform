"use client";

import {
  ClipboardCheck,
  Plus,
  Slash,
  Sparkles,
  Upload
} from "lucide-react";

import { cn } from "@/lib/utils";

export type FabAction = "count" | "waste" | null;

const FAB_FOR: Record<
  string,
  { label: string; icon: typeof Plus; action: FabAction }
> = {
  overview: { label: "Quick count", icon: ClipboardCheck, action: "count" },
  items: { label: "Add item", icon: Plus, action: null },
  recipes: { label: "New recipe", icon: Plus, action: null },
  counts: { label: "Start count", icon: ClipboardCheck, action: "count" },
  receiving: { label: "Receive scan", icon: Upload, action: null },
  vendors: { label: "Add vendor", icon: Plus, action: null },
  waste: { label: "Log waste", icon: Plus, action: "waste" },
  "86": { label: "86 item", icon: Slash, action: null }
};

export interface ContextFabProps {
  active: string;
  mobile: boolean;
  onAction: (action: FabAction) => void;
}

export function ContextFab({ active, mobile, onAction }: ContextFabProps) {
  const fab = FAB_FOR[active] ?? { label: "Action", icon: Sparkles, action: null };
  const Icon = fab.icon;

  return (
    <button
      onClick={() => onAction(fab.action)}
      title={fab.label}
      aria-label={fab.label}
      className={cn(
        "fixed z-30 flex items-center justify-center rounded-full bg-foreground text-background shadow-lg transition hover:opacity-90 active:scale-[0.98]",
        mobile ? "bottom-[136px] right-4 size-14" : "bottom-24 right-6 size-12"
      )}
      style={mobile ? { marginBottom: "env(safe-area-inset-bottom)" } : undefined}
    >
      <Icon className={mobile ? "size-6" : "size-5"} />
    </button>
  );
}
