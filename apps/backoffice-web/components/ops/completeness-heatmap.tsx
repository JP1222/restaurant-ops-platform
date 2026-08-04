"use client";

import type { CompletenessDay, CompletenessStatus } from "@/lib/analytics-api/types";

export const STATUS_STYLE: Record<CompletenessStatus, { bg: string; label: string }> = {
  present: { bg: "var(--trend-up-bg)", label: "Present" },
  missing: { bg: "var(--trend-down)", label: "Missing" },
  warming_up: { bg: "var(--chart-4)", label: "Warming up" },
  closed: { bg: "var(--muted)", label: "Closed" },
  not_loaded: { bg: "var(--border)", label: "Not loaded yet" },
};

function toDate(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

function isoOf(date: Date) {
  return date.toISOString().slice(0, 10);
}

interface Cell {
  iso: string;
  status: CompletenessStatus | null;
}

// GitHub-style coverage grid: weeks as columns, Sun..Sat as rows. A red cell is
// an open day with no ingested data — the holes the calendar-completeness check
// flags. Not a chart (no axes/series), so a div grid rather than ChartContainer.
export function CompletenessHeatmap({ days }: { days: CompletenessDay[] }) {
  if (days.length === 0) {
    return <p className="text-sm text-muted-foreground">No completeness data yet.</p>;
  }

  const statusByDate = new Map(days.map((day) => [day.business_date, day.status]));
  const first = toDate(days[0]!.business_date);
  const last = toDate(days[days.length - 1]!.business_date);

  // Start at the Sunday on/before the first day so each column is a full week.
  const cursor = new Date(first);
  cursor.setUTCDate(cursor.getUTCDate() - cursor.getUTCDay());

  const weeks: Cell[][] = [];
  while (cursor <= last) {
    const week: Cell[] = [];
    for (let dow = 0; dow < 7; dow += 1) {
      const iso = isoOf(cursor);
      const inRange = cursor >= first && cursor <= last;
      week.push({ iso, status: inRange ? statusByDate.get(iso) ?? null : null });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex gap-[3px]">
        {weeks.map((week) => (
          <div key={week[0]!.iso} className="flex flex-col gap-[3px]">
            {week.map((cell) => (
              <div
                key={cell.iso}
                className="size-3 rounded-[2px]"
                style={{
                  backgroundColor: cell.status ? STATUS_STYLE[cell.status].bg : "transparent",
                  border: cell.status ? undefined : "1px solid var(--border)",
                }}
                title={cell.status ? `${cell.iso} · ${STATUS_STYLE[cell.status].label}` : cell.iso}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
