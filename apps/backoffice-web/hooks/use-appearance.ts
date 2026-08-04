"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import {
  ACCENT_PRESETS,
  type Density,
  applyAccent,
  applyDensity,
  applyTabular,
  getAppearanceServerSnapshot,
  getAppearanceSnapshot,
  notifyAppearanceChange,
  persistAppearance,
  subscribeAppearance,
} from "@/lib/appearance";

/**
 * Appearance preferences for the Appearance panel. Theme delegates to
 * next-themes; accent / density / tabular are read reactively from localStorage
 * via useSyncExternalStore (no setState-in-effect) and applied immediately on
 * change, with a custom event so the same tab re-reads the snapshot.
 */
export function useAppearance() {
  const { theme, setTheme } = useTheme();
  const prefs = useSyncExternalStore(
    subscribeAppearance,
    getAppearanceSnapshot,
    getAppearanceServerSnapshot
  );

  const setAccent = (accent: string) => {
    persistAppearance({ accent });
    applyAccent(accent);
    notifyAppearanceChange();
  };

  const setDensity = (density: Density) => {
    persistAppearance({ density });
    applyDensity(density);
    notifyAppearanceChange();
  };

  const setTabular = (tabular: boolean) => {
    persistAppearance({ tabular });
    applyTabular(tabular);
    notifyAppearanceChange();
  };

  return {
    ...prefs,
    accentPresets: ACCENT_PRESETS,
    theme: theme ?? "system",
    setAccent,
    setDensity,
    setTabular,
    setTheme,
  };
}
