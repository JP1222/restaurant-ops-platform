"use client";

import { Check, Loader2, TriangleAlert } from "lucide-react";

export type SaveStatus = "saving" | "saved" | "error";

// Per-field save lifecycle indicator shown next to a control. Mirrors the
// design's StatusPill: muted spinner while saving, accent check on success,
// destructive alert on failure. Callers auto-clear via the status map.
export function StatusPill({ status }: { status?: SaveStatus | null }) {
  if (!status) return null;

  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Saving…
      </span>
    );
  }

  if (status === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95">
        <Check className="size-3.5" /> Saved
      </span>
    );
  }

  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive motion-safe:animate-in motion-safe:fade-in"
    >
      <TriangleAlert className="size-3.5" /> Couldn&apos;t save
    </span>
  );
}
