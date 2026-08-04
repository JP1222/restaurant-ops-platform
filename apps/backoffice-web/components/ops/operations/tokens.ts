// Shared status-tone classes for the Operations panel, built on the repo's
// oklch tokens (same approach as components/ops/status-badge.tsx). Keeps the
// long arbitrary-value class strings in one place.
export const toneClass = {
  accent:
    "border-[color:var(--accent)]/30 bg-[color:var(--accent)]/15 text-[color:var(--accent)]",
  amber:
    "border-[color:var(--chart-4)]/30 bg-[color:var(--chart-4)]/15 text-[color:var(--chart-4)]",
  blue: "border-[color:var(--chart-3)]/30 bg-[color:var(--chart-3)]/15 text-[color:var(--chart-3)]",
  danger:
    "border-[color:var(--destructive)]/30 bg-[color:var(--destructive)]/15 text-[color:var(--destructive)]",
  muted: "border-border bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof toneClass;
