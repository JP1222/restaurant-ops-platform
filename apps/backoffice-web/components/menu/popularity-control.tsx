"use client";

import { Slider } from "@/components/ui/slider";
import { POP_FACTOR_MAX, POP_FACTOR_MIN } from "@/lib/menu/kasavana-smith";

export interface PopularityControlProps {
  value: number;
  onChange: (value: number) => void;
}

/**
 * Tunes the popularity split line: X threshold = (1/N) * popFactor. Lower =
 * more items count as "popular"; higher = stricter. Recomputes the quadrants
 * client-side, no refetch.
 */
export function PopularityControl({ value, onChange }: PopularityControlProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-1.5">
      <label
        htmlFor="popularity-factor"
        className="whitespace-nowrap text-xs font-medium text-muted-foreground"
      >
        Popularity factor
      </label>
      <Slider
        id="popularity-factor"
        className="w-28"
        min={POP_FACTOR_MIN}
        max={POP_FACTOR_MAX}
        step={0.05}
        value={[value]}
        onValueChange={(next) => onChange(next[0] ?? value)}
        aria-label="Popularity factor"
      />
      <span className="w-9 text-right font-mono text-sm tabular-nums">
        {value.toFixed(2)}
      </span>
    </div>
  );
}
