import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const VARIANTS = {
  healthy: {
    label: "Healthy",
    className: "border-[color:var(--accent)]/30 bg-[color:var(--accent)]/15 text-[color:var(--accent)]",
  },
  warning: {
    label: "Warning",
    className:
      "border-[color:var(--chart-4)]/30 bg-[color:var(--chart-4)]/15 text-[color:var(--chart-4)]",
  },
  failed: {
    label: "Failed",
    className:
      "border-[color:var(--destructive)]/30 bg-[color:var(--destructive)]/15 text-[color:var(--destructive)]",
  },
  pending: {
    label: "Pending",
    className: "border-border bg-muted text-muted-foreground",
  },
  running: {
    label: "Running",
    className:
      "border-[color:var(--chart-3)]/30 bg-[color:var(--chart-3)]/15 text-[color:var(--chart-3)]",
  },
  unknown: {
    label: "Unknown",
    className: "border-border bg-muted text-muted-foreground",
  },
} as const;

export type OpsStatus = keyof typeof VARIANTS;

export function StatusBadge({
  status,
  className,
  label,
}: {
  status: OpsStatus;
  className?: string;
  label?: string;
}) {
  const variant = VARIANTS[status] ?? VARIANTS.unknown;

  return (
    <Badge
      variant="outline"
      className={cn("rounded-full font-medium capitalize", variant.className, className)}
    >
      {label ?? variant.label}
    </Badge>
  );
}
