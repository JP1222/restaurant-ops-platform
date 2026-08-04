"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface CommitFieldProps {
  value: string;
  onCommit: (value: string) => void;
  as?: "input" | "textarea";
  type?: "text" | "email";
  rows?: number;
  maxLength?: number;
  showCount?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Text/email/textarea field that commits on blur (or Enter for inputs) and
 * re-syncs from the upstream value when it changes — so an optimistic save that
 * later rolls back reverts the displayed text. Optional live character counter.
 */
export function CommitField({
  value,
  onCommit,
  as = "input",
  type = "text",
  rows = 4,
  maxLength,
  showCount,
  placeholder,
  disabled,
  id,
  className,
}: CommitFieldProps) {
  const [draft, setDraft] = useState(value);
  // Re-sync from the upstream value when it changes (e.g. a rolled-back save) —
  // adjusting state during render instead of a setState-in-effect.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  if (as === "textarea") {
    const atLimit = maxLength != null && draft.length >= maxLength;
    return (
      <div className="w-full">
        <Textarea
          id={id}
          value={draft}
          rows={rows}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className={className}
        />
        {showCount && maxLength != null ? (
          <div className={cn("mt-1 text-right text-xs", atLimit ? "text-destructive" : "text-muted-foreground")}>
            {draft.length.toLocaleString()} / {maxLength.toLocaleString()}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Input
      id={id}
      type={type}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={cn("w-full", className)}
    />
  );
}
