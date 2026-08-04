import type { CategoryPref, NotificationCategory, NotificationPrefs } from "@rop/contracts";

// Category presentation metadata (label + lucide icon) is static — it is NOT
// stored per operator. The DB only persists each operator's toggles + min
// severity; these defaults fill the rest and back an operator who has never
// saved a preference. Mirrors the frontend's DEFAULT_PREFS (PR #798).
export const CATEGORY_ORDER: NotificationCategory[] = ["sales", "inv", "dev", "cost", "intg"];

export const CATEGORY_META: Record<NotificationCategory, { label: string; icon: string }> = {
  sales: { label: "Sales", icon: "trending-up" },
  inv: { label: "Inventory", icon: "package" },
  dev: { label: "Devices", icon: "monitor" },
  cost: { label: "Costs & Ops", icon: "dollar-sign" },
  intg: { label: "Integrations", icon: "plug" }
};

type CategoryToggles = Pick<CategoryPref, "inapp" | "email" | "push" | "sev">;

export const DEFAULT_CATEGORY_TOGGLES: Record<NotificationCategory, CategoryToggles> = {
  sales: { inapp: true, email: true, push: true, sev: "warn" },
  inv: { inapp: true, email: false, push: true, sev: "warn" },
  dev: { inapp: true, email: false, push: true, sev: "crit" },
  cost: { inapp: true, email: true, push: false, sev: "warn" },
  intg: { inapp: true, email: false, push: false, sev: "crit" }
};

export const DEFAULT_QUIET = { quiet: true, quietFrom: "10:00 PM", quietTo: "7:00 AM" } as const;

export function defaultCategoryPref(category: NotificationCategory): CategoryPref {
  return { ...CATEGORY_META[category], ...DEFAULT_CATEGORY_TOGGLES[category] };
}

export function defaultPrefs(): NotificationPrefs {
  const cats = {} as Record<NotificationCategory, CategoryPref>;
  for (const category of CATEGORY_ORDER) {
    cats[category] = defaultCategoryPref(category);
  }
  return { ...DEFAULT_QUIET, cats };
}
