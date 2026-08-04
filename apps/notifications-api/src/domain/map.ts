import {
  AiInvestigationSchema,
  type AiInvestigation,
  type CategoryPref,
  type MinSeverity,
  type Notification as NotificationDto,
  type NotificationCategory,
  type NotificationPrefs,
  type NotificationSeverity
} from "@rop/contracts";

import { CATEGORY_META, CATEGORY_ORDER, defaultCategoryPref, defaultPrefs } from "./defaults.js";

// Structural shapes of the DB rows this service reads. Enum columns carry the
// exact contract strings (see the schema), so they flow through untyped-mapped.
export interface NotificationRow {
  id: string;
  severity: NotificationSeverity;
  category: NotificationCategory;
  categoryLabel: string;
  icon: string;
  title: string;
  detail: string;
  actionLabel: string;
  actionIcon: string;
  actionHref: string;
  ai: unknown;
  createdAt: Date;
}

export interface StateRow {
  read: boolean;
  snoozedUntil: Date | null;
  dismissedAt: Date | null;
}

export interface PrefRow {
  quiet: boolean;
  quietFrom: string;
  quietTo: string;
}

export interface CategoryPrefRow {
  category: NotificationCategory;
  inapp: boolean;
  email: boolean;
  push: boolean;
  minSeverity: MinSeverity;
}

// Stored AI investigation is trusted (a producer validated it on write) but
// re-validated here so a malformed row degrades to text-less rather than
// breaking the list response.
function parseAi(value: unknown): AiInvestigation | undefined {
  if (value == null) return undefined;
  const parsed = AiInvestigationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Visible to this operator: no dismissal, and no active snooze. */
export function isLive(state: StateRow | undefined, now: number): boolean {
  if (!state) return true;
  if (state.dismissedAt) return false;
  if (state.snoozedUntil && state.snoozedUntil.getTime() > now) return false;
  return true;
}

export function toDto(n: NotificationRow, state: StateRow | undefined): NotificationDto {
  const ai = parseAi(n.ai);
  return {
    id: n.id,
    severity: n.severity,
    category: n.category,
    categoryLabel: n.categoryLabel,
    icon: n.icon,
    title: n.title,
    detail: n.detail,
    createdAt: n.createdAt.toISOString(),
    read: state?.read ?? false,
    snoozedUntil: state?.snoozedUntil ? state.snoozedUntil.toISOString() : null,
    dismissedAt: state?.dismissedAt ? state.dismissedAt.toISOString() : null,
    action: { label: n.actionLabel, icon: n.actionIcon, href: n.actionHref },
    ...(ai ? { ai } : {})
  };
}

export function assemblePrefs(pref: PrefRow | null, categories: CategoryPrefRow[]): NotificationPrefs {
  if (!pref) return defaultPrefs();
  const byCategory = new Map(categories.map((c) => [c.category, c]));
  const cats = {} as Record<NotificationCategory, CategoryPref>;
  for (const category of CATEGORY_ORDER) {
    const row = byCategory.get(category);
    cats[category] = row
      ? { ...CATEGORY_META[category], inapp: row.inapp, email: row.email, push: row.push, sev: row.minSeverity }
      : defaultCategoryPref(category);
  }
  return { quiet: pref.quiet, quietFrom: pref.quietFrom, quietTo: pref.quietTo, cats };
}
