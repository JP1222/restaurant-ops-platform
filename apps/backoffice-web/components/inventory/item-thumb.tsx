import { Package } from "lucide-react";

import { itemImageUrl } from "@/lib/inventory/item-image";
import { cn } from "@/lib/utils";
import type { InventoryItem } from "@rop/contracts";

// Read-only item thumbnail. Visual-identity precedence: uploaded photo (proxied via
// our BFF) > operator-chosen emoji `icon` > the neutral Package glyph. Sized by the
// container `className`; the glyph scales with it.
export function ItemThumb({
  item,
  className
}: {
  item: Pick<InventoryItem, "id" | "has_image" | "icon">;
  className?: string;
}) {
  if (item.has_image) {
    return (
      <div className={cn("overflow-hidden rounded-lg bg-secondary", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- photo proxied through our BFF; next/image's loader isn't wired for it */}
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
    <div className={cn("flex items-center justify-center rounded-lg bg-secondary", className)}>
      {item.icon ? (
        <span className="text-lg leading-none">{item.icon}</span>
      ) : (
        <Package className="size-[55%] text-muted-foreground" />
      )}
    </div>
  );
}
