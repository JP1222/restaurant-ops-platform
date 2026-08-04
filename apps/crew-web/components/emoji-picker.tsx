"use client";

import { cn } from "@/lib/cn";
import { ITEM_ICON_GROUPS } from "@/lib/item-icons";
import { STRINGS } from "@/lib/strings";
import type { Lang } from "@/lib/types";

// Item-icon picker: a bottom-sheet (phone) / centered card (tablet) grid of curated
// emojis grouped by kitchen category. Touch-first — big tap targets, scroll body,
// tap-outside / × to dismiss. No external emoji-picker dep (crew-web stays lean);
// the catalog is plain data in lib/item-icons.ts. `onPick` sets the icon, `onClear`
// resets to the default (category) glyph.
export function EmojiPicker({
  lang,
  current,
  onPick,
  onClear,
  onClose,
}: {
  lang: Lang;
  current?: string;
  onPick: (emoji: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const T = STRINGS[lang];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button aria-label={T.cancel} onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div
        className="relative flex max-h-[82vh] w-full flex-col rounded-t-3xl bg-white shadow-2xl sm:max-w-lg sm:rounded-3xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 pb-3 pt-4">
          <h3 className="text-lg font-semibold text-zinc-900">{T.icon_picker_title}</h3>
          <button
            onClick={onClose}
            aria-label={T.cancel}
            className="flex size-9 items-center justify-center rounded-full bg-zinc-100 text-2xl leading-none text-zinc-500"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {ITEM_ICON_GROUPS.map((g) => (
            <div key={g.key} className="mb-3">
              <div className="px-2 pb-1.5 text-[13px] font-medium text-zinc-400">{T[g.labelKey]}</div>
              <div className="grid grid-cols-6 gap-1 sm:grid-cols-8">
                {g.emojis.map((e) => (
                  <button
                    key={e}
                    onClick={() => onPick(e)}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-xl text-[26px] transition-transform active:scale-90",
                      current === e ? "bg-violet-100 ring-2 ring-violet-400" : "hover:bg-zinc-100",
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-zinc-100 px-5 py-3">
          <button onClick={onClear} className="text-sm text-zinc-500 underline">
            {T.icon_picker_clear}
          </button>
        </div>
      </div>
    </div>
  );
}
