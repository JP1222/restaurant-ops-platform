// Curated emoji catalog for the item-icon picker, grouped for an ice-cream /
// bubble-tea / quick-serve catalog. Hand-picked rather than pulling a multi-megabyte
// full-emoji dataset + picker dependency (shadcn-only, no second component lib —
// AGENTS.md rule 4). Plain data, reused by the detail sheet + add-item dialog.

export interface ItemIconGroup {
  key: string;
  label: string;
  emojis: string[];
}

export const ITEM_ICON_GROUPS: ItemIconGroup[] = [
  {
    key: "drinks",
    label: "Drinks",
    emojis: ["🥤", "🧋", "🧃", "🥛", "☕", "🍵", "🧉", "🫖", "🍶", "🍹", "🍸", "🍷", "🍺", "🍻", "🥃", "🍾", "🥂", "🧊", "💧", "🫗"],
  },
  {
    key: "dairy",
    label: "Dairy & ice cream",
    emojis: ["🍦", "🍨", "🍧", "🧁", "🍰", "🎂", "🥧", "🍮", "🧈", "🧀", "🥚", "🐄", "🍼"],
  },
  {
    key: "fruit",
    label: "Fruit",
    emojis: ["🍓", "🍌", "🥭", "🍍", "🍑", "🍒", "🍇", "🍉", "🍊", "🍋", "🍎", "🍏", "🥝", "🫐", "🥥", "🍐", "🍈", "🍅", "🫒", "🥑"],
  },
  {
    key: "veg",
    label: "Vegetables",
    emojis: ["🥕", "🌽", "🥒", "🥬", "🥦", "🧅", "🧄", "🍆", "🫑", "🌶️", "🥔", "🍠", "🍄", "🫛", "🌰"],
  },
  {
    key: "food",
    label: "Food",
    emojis: ["🍗", "🍖", "🥩", "🥓", "🌭", "🍔", "🍟", "🍕", "🥪", "🌮", "🌯", "🫔", "🥗", "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🍙", "🍚", "🍘", "🦐", "🦀", "🐟", "🥟", "🥠", "🍤"],
  },
  {
    key: "bakery",
    label: "Bakery & bread",
    emojis: ["🍞", "🥐", "🥖", "🥨", "🥯", "🧇", "🥞", "🍳", "🫓", "🧆"],
  },
  {
    key: "toppings",
    label: "Toppings & candy",
    emojis: ["🟤", "⚪", "🔘", "🍫", "🍬", "🍭", "🍯", "🥜", "🫘", "🍪", "🌈", "✨", "🌸", "🎉", "🫧"],
  },
  {
    key: "packaging",
    label: "Packaging",
    emojis: ["📦", "🥡", "🛍️", "🥢", "🍽️", "🥄", "🍴", "🫙", "🥫", "🧂", "🧴", "🗳️", "🧺", "🏺"],
  },
  {
    key: "supplies",
    label: "Supplies",
    emojis: ["🧻", "🧼", "🧽", "🧤", "🧹", "🪣", "🔪", "🔥", "❄️", "🧯", "🏷️", "🔋", "💡", "🧰", "⚖️", "📏", "🪤", "🧷"],
  },
  {
    key: "symbols",
    label: "Symbols",
    emojis: ["⭐", "❤️", "✅", "⚠️", "🔴", "🟢", "🟡", "🔵", "🟣", "🟠", "⚫", "📌", "⏰", "💲", "🆕", "🔔", "♻️", "🚫", "❌", "💯"],
  },
];
