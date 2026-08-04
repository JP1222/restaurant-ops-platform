"use client";

import { ClipboardCheck, Slash, Trash2, Truck } from "lucide-react";

import { cn } from "@/lib/utils";

const ITEMS: { id: string; icon: typeof ClipboardCheck; label: string }[] = [
  { id: "counts", icon: ClipboardCheck, label: "Count" },
  { id: "receiving", icon: Truck, label: "Receive" },
  { id: "waste", icon: Trash2, label: "Waste" },
  { id: "86", icon: Slash, label: "86" }
];

export interface MobileBottomNavProps {
  active: string;
  onChange: (id: string) => void;
}

export function MobileBottomNav({ active, onChange }: MobileBottomNavProps) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80 lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Quick actions"
    >
      <ul className="grid grid-cols-4">
        {ITEMS.map((it) => {
          const isActive = active === it.id;
          return (
            <li key={it.id}>
              <button
                onClick={() => onChange(it.id)}
                className={cn(
                  "flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                  isActive ? "text-accent" : "text-muted-foreground"
                )}
              >
                <it.icon className="size-5" />
                {it.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
