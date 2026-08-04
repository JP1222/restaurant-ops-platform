import type * as React from "react";

import { cn } from "@/lib/utils";
import type { InventoryItemStatus } from "@rop/contracts";

import { STATUS_LABEL, STATUS_TONE, type StatusBadgeTone } from "@/lib/inventory/helpers";

const TONE_CLASSES: Record<StatusBadgeTone, string> = {
  accent: "bg-trend-up-bg text-trend-up border-transparent",
  warn: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60",
  danger: "bg-trend-down-bg text-trend-down border-transparent",
  info: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900/60",
  eightysix: "bg-zinc-900 text-zinc-50 border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100"
};

export interface StatusBadgeProps {
  status: InventoryItemStatus;
  dot?: boolean;
  className?: string;
}

export function StatusBadge({ status, dot = true, className }: StatusBadgeProps) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className
      )}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current opacity-90" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface ToneBadgeProps {
  tone: StatusBadgeTone | "outline" | "neutral";
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function ToneBadge({ tone, dot = false, className, children }: ToneBadgeProps) {
  const cls =
    tone === "outline"
      ? "bg-transparent text-foreground border-border"
      : tone === "neutral"
        ? "bg-secondary text-secondary-foreground border-border"
        : TONE_CLASSES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        cls,
        className
      )}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current opacity-90" /> : null}
      {children}
    </span>
  );
}
