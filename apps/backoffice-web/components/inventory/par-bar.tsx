import { cn } from "@/lib/utils";
import type { InventoryItem, InventoryItemStatus } from "@rop/contracts";

export interface ParBarProps {
  item: InventoryItem;
  status: InventoryItemStatus;
  className?: string;
}

export function ParBar({ item, status, className }: ParBarProps) {
  const widthOnHand = Math.min(110, (item.on_hand / item.par_max) * 100);
  const widthMinTick = (item.par_min / item.par_max) * 100;
  const tone =
    status === "critical" || status === "86"
      ? "bg-trend-down"
      : status === "low"
        ? "bg-amber-500"
        : status === "over"
          ? "bg-sky-500"
          : "bg-accent";

  return (
    <div
      className={cn(
        "relative h-1.5 rounded-full bg-secondary overflow-hidden",
        className ?? "min-w-[80px] w-[110px]"
      )}
    >
      <div
        className={cn("h-full rounded-full", tone)}
        style={{ width: `${Math.min(widthOnHand, 100)}%` }}
      />
      <div
        className="absolute top-[-2px] h-[10px] w-px bg-foreground/50"
        style={{ left: `${widthMinTick}%` }}
        title={`min ${item.par_min}`}
      />
    </div>
  );
}
