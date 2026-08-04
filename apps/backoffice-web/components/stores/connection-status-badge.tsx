"use client";

import { cn } from "@/lib/utils";

export type ConnectionStatus = "connected" | "none" | "expiring" | "error";

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  compact?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; shortLabel: string; dotClass: string; badgeClass: string }
> = {
  connected: {
    label: "Connected",
    shortLabel: "Connected",
    dotClass: "bg-accent",
    badgeClass: "bg-accent-soft text-trend-up",
  },
  none: {
    label: "Not connected",
    shortLabel: "Not set",
    dotClass: "bg-muted-foreground/40",
    badgeClass: "bg-muted text-muted-foreground",
  },
  expiring: {
    label: "Token expiring",
    shortLabel: "Expiring",
    dotClass: "bg-warn",
    badgeClass: "bg-warn-soft text-warn-foreground",
  },
  error: {
    label: "Error",
    shortLabel: "Error",
    dotClass: "bg-destructive",
    badgeClass: "bg-destructive-soft text-destructive",
  },
};

export function ConnectionStatusBadge({ status, compact = false, className }: ConnectionStatusBadgeProps) {
  const { label, shortLabel, dotClass, badgeClass } = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        badgeClass,
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      {compact ? shortLabel : label}
    </span>
  );
}
