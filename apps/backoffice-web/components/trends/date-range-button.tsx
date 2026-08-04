"use client";

import { useState } from "react";
import { DateTime } from "luxon";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const STORE_TZ = "America/Chicago";

interface Preset {
  label: string;
  days: number;
}

const PRESETS: Preset[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function rangeForPreset(days: number): { from: string; to: string } {
  const today = DateTime.now().setZone(STORE_TZ);
  return {
    from: today.minus({ days: days - 1 }).toFormat("yyyy-MM-dd"),
    to: today.toFormat("yyyy-MM-dd"),
  };
}

function dateFromISO(value: string): Date {
  return DateTime.fromISO(value, { zone: STORE_TZ }).toJSDate();
}

function formatRange(from: string, to: string): string {
  const fromDate = DateTime.fromISO(from, { zone: STORE_TZ });
  const toDate = DateTime.fromISO(to, { zone: STORE_TZ });

  return `${fromDate.toFormat("LLL d")} - ${toDate.toFormat("LLL d, y")}`;
}

export interface DateRangeButtonProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

export function DateRangeButton({ from, to, onChange }: DateRangeButtonProps) {
  const [open, setOpen] = useState(false);
  const selected: DateRange = {
    from: dateFromISO(from),
    to: dateFromISO(to),
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <CalendarIcon data-icon="inline-start" />
          {formatRange(from, to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto" align="start">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                onClick={() => {
                  const range = rangeForPreset(preset.days);
                  onChange(range.from, range.to);
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={selected}
            timeZone={STORE_TZ}
            onSelect={(range) => {
              if (!range?.from || !range.to) return;

              const nextFrom = DateTime.fromJSDate(range.from, { zone: STORE_TZ }).toFormat(
                "yyyy-MM-dd",
              );
              const nextTo = DateTime.fromJSDate(range.to, { zone: STORE_TZ }).toFormat(
                "yyyy-MM-dd",
              );

              onChange(nextFrom, nextTo);
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
