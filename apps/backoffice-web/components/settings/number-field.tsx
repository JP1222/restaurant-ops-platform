"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  id?: string;
  onCommit: (value: number) => void;
}

/**
 * Numeric input with inline range validation. Unlike the old NumberRow (which
 * silently snapped out-of-range input back to the last good value), this keeps
 * the typed value, flags the field invalid, and surfaces a message. It only
 * commits when valid and changed.
 */
export function NumberField({ value, min, max, unit, disabled, id, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  // Re-sync from the upstream value when it changes (e.g. an optimistic save
  // rolled back) — adjusting state during render, the React-recommended
  // alternative to a setState-in-effect.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(String(value));
    setError(null);
  }

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setError(`Enter a number between ${min.toLocaleString()} and ${max.toLocaleString()}.`);
      return;
    }
    setError(null);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="w-full">
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          disabled={disabled}
          aria-invalid={error != null}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className={cn("tabular-nums", unit && "pr-14")}
        />
        {unit ? (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
            {unit}
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-right text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
