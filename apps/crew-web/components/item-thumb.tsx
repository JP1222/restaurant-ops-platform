"use client";

import { itemImageUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ITEM_GLYPHS } from "@/lib/employees";
import type { InventoryItem } from "@rop/contracts";

// Item thumbnail used across the floor pickers + confirmations. Visual identity
// precedence: the uploaded photo when the item has one (served same-origin via the
// BFF proxy) > the operator-chosen emoji `icon` > the seeded category glyph, so an
// item without a photo still reads at a glance. `className` supplies the box size +
// (for the glyph) the text size.
export function ItemThumb({
  item,
  className,
  rounded = "rounded-xl",
}: {
  item: Pick<InventoryItem, "id" | "has_image" | "icon">;
  className?: string;
  rounded?: string;
}) {
  if (item.has_image) {
    return (
      <div className={cn("overflow-hidden bg-zinc-100", rounded, className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- floor photo proxied
            through our own BFF; next/image's loader/optimizer isn't wired here. */}
        <img
          src={itemImageUrl(item.id)}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      </div>
    );
  }
  return (
    <div className={cn("flex items-center justify-center bg-zinc-100", rounded, className)}>
      {item.icon || ITEM_GLYPHS[item.id] || "📦"}
    </div>
  );
}
