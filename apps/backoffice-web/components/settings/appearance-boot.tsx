"use client";

import { useEffect } from "react";
import { applyAppearance, readAppearance } from "@/lib/appearance";

// Re-applies the persisted appearance prefs (accent / density / tabular) on
// every load so they survive reloads app-wide, not just while the Appearance
// panel is mounted. Theme is handled separately by next-themes.
export function AppearanceBoot() {
  useEffect(() => {
    applyAppearance(readAppearance());
  }, []);
  return null;
}
