import type { Category, MinSeverity, Severity } from "./types";

// Token-backed Tailwind classes. Kept as complete literals (no interpolation) so
// the Tailwind JIT scanner generates them. "info" severity is intentionally
// neutral/muted here — distinct from the app's blue --info token.

export const severityMeta: Record<
  Severity,
  { label: string; text: string; tileBg: string; dot: string; bar: string }
> = {
  crit: {
    label: "Critical",
    text: "text-destructive",
    tileBg: "bg-destructive-soft",
    dot: "bg-destructive",
    bar: "bg-destructive",
  },
  warn: {
    label: "Warning",
    text: "text-warn",
    tileBg: "bg-warn-soft",
    dot: "bg-warn",
    bar: "bg-warn",
  },
  info: {
    label: "Info",
    text: "text-muted-foreground",
    tileBg: "bg-muted",
    dot: "bg-muted-foreground",
    bar: "bg-muted-foreground",
  },
};

export const categoryMeta: Record<Category, { label: string; tagBg: string; tagText: string }> = {
  sales: { label: "Sales", tagBg: "bg-cat-sales-soft", tagText: "text-cat-sales" },
  inv: { label: "Inventory", tagBg: "bg-cat-inv-soft", tagText: "text-cat-inv" },
  dev: { label: "Devices", tagBg: "bg-cat-dev-soft", tagText: "text-cat-dev" },
  cost: { label: "Costs & Ops", tagBg: "bg-cat-cost-soft", tagText: "text-cat-cost" },
  intg: { label: "Integrations", tagBg: "bg-cat-intg-soft", tagText: "text-cat-intg" },
};

export const minSeverityMeta: Record<MinSeverity, { label: string; text: string; dot: string }> = {
  all: { label: "All severities", text: "text-muted-foreground", dot: "bg-muted-foreground" },
  warn: { label: "Warning & up", text: "text-warn", dot: "bg-warn" },
  crit: { label: "Critical only", text: "text-destructive", dot: "bg-destructive" },
};

/** Cycle order for the Preferences min-severity pill. */
export const MIN_SEVERITY_CYCLE: MinSeverity[] = ["all", "warn", "crit"];
