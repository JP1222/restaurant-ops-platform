"use client";

import { useEffect, useState } from "react";
import { DateTime } from "luxon";

export function RelativeTime({ iso }: { iso?: string | null }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  if (!iso) {
    return <span className="text-muted-foreground">-</span>;
  }

  const date = DateTime.fromISO(iso);
  if (!date.isValid) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <time dateTime={iso} title={date.toISO() ?? ""} className="tabular-nums">
      {date.toRelative() ?? "-"}
    </time>
  );
}
