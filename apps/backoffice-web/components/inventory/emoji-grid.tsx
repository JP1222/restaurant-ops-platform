"use client";

import { ITEM_ICON_GROUPS } from "@/lib/item-icons";
import { cn } from "@/lib/utils";

// The grouped emoji grid shared by the item-detail icon control and the add-item
// dialog. Pure presentation: `onPick` reports the chosen emoji, `selected` highlights
// the current one. Wrap it in a Popover at the call site.
export function EmojiGrid({
  selected,
  onPick,
  className
}: {
  selected?: string;
  onPick: (emoji: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("max-h-72 overflow-y-auto p-2", className)}>
      {ITEM_ICON_GROUPS.map((g) => (
        <div key={g.key} className="mb-2">
          <div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
          <div className="grid grid-cols-8 gap-0.5">
            {g.emojis.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-md text-lg hover:bg-secondary",
                  selected === e && "bg-secondary ring-1 ring-ring"
                )}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
