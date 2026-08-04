// Curated emoji catalog for the item-icon picker. Hand-picked + grouped for an
// ice-cream / bubble-tea / quick-serve catalog rather than pulling a multi-megabyte
// full-emoji dataset + picker dep (crew-web is intentionally lean — see AGENTS.md
// "Do not pull in heavy UI deps"). Each group's label is an i18n StringKey so the
// picker stays bilingual. Kept as plain data so it can be reused by any surface.

import type { StringKey } from "./strings";

export interface ItemIconGroup {
  key: string;
  labelKey: StringKey;
  emojis: string[];
}

export const ITEM_ICON_GROUPS: ItemIconGroup[] = [
  {
    key: "drinks",
    labelKey: "icon_grp_drinks",
    emojis: ["🥤", "🧋", "🧃", "🥛", "☕", "🍵", "🧉", "🫖", "🍶", "🍹", "🍸", "🍷", "🍺", "🍻", "🥃", "🍾", "🥂", "🧊", "💧", "🫗"],
  },
  {
    key: "dairy",
    labelKey: "icon_grp_dairy",
    emojis: ["🍦", "🍨", "🍧", "🧁", "🍰", "🎂", "🥧", "🍮", "🧈", "🧀", "🥚", "🐄", "🍼"],
  },
  {
    key: "fruit",
    labelKey: "icon_grp_fruit",
    emojis: ["🍓", "🍌", "🥭", "🍍", "🍑", "🍒", "🍇", "🍉", "🍊", "🍋", "🍎", "🍏", "🥝", "🫐", "🥥", "🍐", "🍈", "🍅", "🫒", "🥑"],
  },
  {
    key: "veg",
    labelKey: "icon_grp_veg",
    emojis: ["🥕", "🌽", "🥒", "🥬", "🥦", "🧅", "🧄", "🍆", "🫑", "🌶️", "🥔", "🍠", "🍄", "🫛", "🌰"],
  },
  {
    key: "food",
    labelKey: "icon_grp_food",
    emojis: ["🍗", "🍖", "🥩", "🥓", "🌭", "🍔", "🍟", "🍕", "🥪", "🌮", "🌯", "🫔", "🥗", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🍙", "🍚", "🍘", "🦐", "🦀", "🐟", "🥟", "🥠", "🍤"],
  },
  {
    key: "bakery",
    labelKey: "icon_grp_bakery",
    emojis: ["🍞", "🥐", "🥖", "🥨", "🥯", "🧇", "🥞", "🍳", "🫓", "🧆"],
  },
  {
    key: "toppings",
    labelKey: "icon_grp_toppings",
    emojis: ["🟤", "⚪", "🔘", "🍫", "🍬", "🍭", "🍯", "🥜", "🫘", "🍪", "🌈", "✨", "🌸", "🎉", "🫧"],
  },
  {
    key: "packaging",
    labelKey: "icon_grp_packaging",
    emojis: ["📦", "🥡", "🛍️", "🥢", "🍽️", "🥄", "🍴", "🫙", "🥫", "🧂", "🧴", "🗳️", "🧺", "🏺"],
  },
  {
    key: "supplies",
    labelKey: "icon_grp_supplies",
    emojis: ["🧻", "🧼", "🧽", "🧤", "🧹", "🪣", "🔪", "🔥", "❄️", "🧯", "🏷️", "🔋", "💡", "🧰", "⚖️", "📏", "🪤", "🧷"],
  },
  {
    key: "symbols",
    labelKey: "icon_grp_symbols",
    emojis: ["⭐", "❤️", "✅", "⚠️", "🔴", "🟢", "🟡", "🔵", "🟣", "🟠", "⚫", "📌", "⏰", "💲", "🆕", "🔔", "♻️", "🚫", "❌", "💯"],
  },
];
