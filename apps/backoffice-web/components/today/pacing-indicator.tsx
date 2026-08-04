import { Progress } from "@/components/ui/progress";
import type { PacingState } from "@/lib/analytics-api/hourly-transform";

export function PacingIndicator({ pacing }: { pacing: PacingState }) {
  const displayPct = `${Math.round(pacing.progress_pct)}%`;
  const progressValue = Math.max(0, Math.min(100, pacing.progress_pct));
  const hoursLeft = pacing.hours_remaining;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="text-muted-foreground">
          Sales pacing:{" "}
          <span className="text-foreground font-medium tabular-nums">{displayPct}</span> of typical
          day
        </span>
        <span className="text-muted-foreground tabular-nums">
          {hoursLeft} {hoursLeft === 1 ? "hour" : "hours"} remaining
        </span>
      </div>
      <Progress className="h-2" value={progressValue} />
    </div>
  );
}
