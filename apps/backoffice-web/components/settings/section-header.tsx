import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  tone?: "danger";
  action?: ReactNode;
}

// Section header for every Settings panel: a tinted icon tile + title + muted
// subtitle, with an optional right-aligned action slot.
export function SectionHeader({ icon: Icon, title, subtitle, tone, action }: SectionHeaderProps) {
  const danger = tone === "danger";
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3.5">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            danger ? "bg-destructive-soft text-destructive" : "bg-accent-soft text-accent"
          )}
        >
          <Icon className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {action ?? null}
    </div>
  );
}
