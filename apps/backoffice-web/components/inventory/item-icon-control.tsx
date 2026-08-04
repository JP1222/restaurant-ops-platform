"use client";

import * as React from "react";
import { ImagePlus, Loader2, Package, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useItemImage } from "@/hooks/use-inventory";
import { itemImageUrl } from "@/lib/inventory/item-image";
import { resizeImageForUpload } from "@/lib/inventory/resize-image";
import type { InventoryItem } from "@rop/contracts";

import { EmojiGrid } from "./emoji-grid";

// Editable item visual identity: the avatar in the item detail header. Tap to open a
// popover that sets an emoji `icon` (saved via the catalog editor) OR uploads a photo
// (reuses the inventory-api image endpoints). Display precedence photo > emoji >
// Package. `onPickIcon` writes the emoji through the sheet's saveItem path; the photo
// goes through useItemImage directly.
export function ItemIconControl({
  item,
  onPickIcon
}: {
  item: InventoryItem;
  onPickIcon: (icon: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const { upload, remove, isPending } = useItemImage(item.id);

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const resized = await resizeImageForUpload(file);
      await upload(resized);
      setOpen(false);
    } catch {
      // leave the popover open so the operator can retry
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Change item icon"
          className="relative flex size-10 flex-none items-center justify-center overflow-hidden rounded-lg bg-secondary transition hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {item.has_image ? (
            // eslint-disable-next-line @next/next/no-img-element -- photo proxied through our BFF
            <img src={itemImageUrl(item.id)} alt="" className="h-full w-full object-cover" />
          ) : item.icon ? (
            <span className="text-xl leading-none">{item.icon}</span>
          ) : (
            <Package className="size-5 text-muted-foreground" />
          )}
          <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background">
            <Pencil className="size-2.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <EmojiGrid
          selected={item.icon}
          onPick={(e) => {
            onPickIcon(e);
            setOpen(false);
          }}
        />
        <div className="flex items-center gap-2 border-t border-border p-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => fileRef.current?.click()}
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ImagePlus className="size-3.5" />
            )}
            Photo
          </Button>
          {(item.has_image || item.icon) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-trend-down hover:text-trend-down"
              disabled={isPending}
              onClick={async () => {
                if (item.has_image) await remove();
                if (item.icon) onPickIcon("");
                setOpen(false);
              }}
            >
              <Trash2 className="size-3.5" />
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
