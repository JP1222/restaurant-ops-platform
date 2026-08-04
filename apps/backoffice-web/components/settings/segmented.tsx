"use client";

import type { LucideIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type SegmentedOption = { value: string; label: string; icon?: LucideIcon };

interface SegmentedProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedOption[];
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Single-select segmented control. Thin wrapper over shadcn's ToggleGroup
 * styled to the design's pill look (secondary track, active = raised
 * background). Guards against deselection so a value is always set.
 */
export function Segmented({ value, onValueChange, options, disabled, className, ...rest }: SegmentedProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      spacing={1}
      size="sm"
      disabled={disabled}
      aria-label={rest["aria-label"]}
      className={cn("bg-secondary p-0.5", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="px-3 text-xs font-medium text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
        >
          {option.icon ? <option.icon /> : null}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
