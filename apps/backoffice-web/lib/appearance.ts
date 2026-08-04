// Per-operator appearance preferences, persisted to localStorage and applied as
// inline CSS variables on <html>. Theme (light/dark/system) is owned by
// next-themes; accent / density / tabular-numerals live here.

export type Density = "compact" | "regular" | "comfy";

export interface AccentPreset {
  id: string;
  label: string;
  value: string;
}

// Brand green — the existing --accent default. Kept as a named constant so
// DEFAULT_ACCENT doesn't index into the array (noUncheckedIndexedAccess).
const KITCHEN_GREEN = "oklch(0.6 0.13 158)";

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "green", label: "Kitchen", value: KITCHEN_GREEN },
  { id: "blue", label: "Ocean", value: "oklch(0.55 0.16 250)" },
  { id: "violet", label: "Grape", value: "oklch(0.55 0.2 295)" },
  { id: "amber", label: "Citrus", value: "oklch(0.68 0.17 60)" },
  { id: "rose", label: "Berry", value: "oklch(0.6 0.2 12)" },
];

export const DENSITY_ROW_Y: Record<Density, string> = {
  compact: "0.75rem",
  regular: "1.125rem",
  comfy: "1.625rem",
};

export const DEFAULT_ACCENT = KITCHEN_GREEN;
export const DEFAULT_DENSITY: Density = "regular";
export const DEFAULT_TABULAR = true;

const STORAGE_KEYS = {
  accent: "yr-accent",
  density: "yr-density",
  tabular: "yr-tabular",
} as const;

export interface AppearancePrefs {
  accent: string;
  density: Density;
  tabular: boolean;
}

const DENSITIES: Density[] = ["compact", "regular", "comfy"];

function isDensity(value: string | null): value is Density {
  return value != null && (DENSITIES as string[]).includes(value);
}

export function applyAccent(accent: string): void {
  const el = document.documentElement;
  el.style.setProperty("--accent", accent);
  el.style.setProperty("--ring", accent);
  el.style.setProperty("--accent-soft", `color-mix(in oklch, ${accent} 16%, var(--background))`);
}

export function applyDensity(density: Density): void {
  document.documentElement.style.setProperty("--settings-row-y", DENSITY_ROW_Y[density]);
}

export function applyTabular(on: boolean): void {
  document.documentElement.style.fontVariantNumeric = on ? "tabular-nums" : "normal";
}

export function applyAppearance(prefs: AppearancePrefs): void {
  applyAccent(prefs.accent);
  applyDensity(prefs.density);
  applyTabular(prefs.tabular);
}

export function readAppearance(): AppearancePrefs {
  if (typeof window === "undefined") {
    return { accent: DEFAULT_ACCENT, density: DEFAULT_DENSITY, tabular: DEFAULT_TABULAR };
  }
  const density = localStorage.getItem(STORAGE_KEYS.density);
  const tabular = localStorage.getItem(STORAGE_KEYS.tabular);
  return {
    accent: localStorage.getItem(STORAGE_KEYS.accent) ?? DEFAULT_ACCENT,
    density: isDensity(density) ? density : DEFAULT_DENSITY,
    tabular: tabular == null ? DEFAULT_TABULAR : tabular === "true",
  };
}

export function persistAppearance(prefs: Partial<AppearancePrefs>): void {
  if (prefs.accent != null) localStorage.setItem(STORAGE_KEYS.accent, prefs.accent);
  if (prefs.density != null) localStorage.setItem(STORAGE_KEYS.density, prefs.density);
  if (prefs.tabular != null) localStorage.setItem(STORAGE_KEYS.tabular, String(prefs.tabular));
}

// --- useSyncExternalStore plumbing -----------------------------------------
// Read appearance prefs reactively without a setState-in-effect. The snapshot
// is cached and only re-derived when the underlying storage signature changes,
// so getSnapshot returns a stable reference (no render loop).

const SERVER_SNAPSHOT: AppearancePrefs = {
  accent: DEFAULT_ACCENT,
  density: DEFAULT_DENSITY,
  tabular: DEFAULT_TABULAR,
};

export const APPEARANCE_EVENT = "yr-appearance-change";

let cachedSnapshot: AppearancePrefs = SERVER_SNAPSHOT;
let cachedSignature: string | null = null;

export function getAppearanceSnapshot(): AppearancePrefs {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  const signature = [
    localStorage.getItem(STORAGE_KEYS.accent) ?? "",
    localStorage.getItem(STORAGE_KEYS.density) ?? "",
    localStorage.getItem(STORAGE_KEYS.tabular) ?? "",
  ].join("|");
  if (signature !== cachedSignature) {
    cachedSignature = signature;
    cachedSnapshot = readAppearance();
  }
  return cachedSnapshot;
}

export function getAppearanceServerSnapshot(): AppearancePrefs {
  return SERVER_SNAPSHOT;
}

export function subscribeAppearance(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(APPEARANCE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(APPEARANCE_EVENT, callback);
  };
}

// Storage events don't fire in the tab that made the change, so setters call
// this to notify same-tab subscribers.
export function notifyAppearanceChange(): void {
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}
