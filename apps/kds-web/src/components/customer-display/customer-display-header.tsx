"use client";

import { useEffect, useState } from "react";
import type { CustomerDisplayWeatherSettings } from "@rop/contracts";
import { CustomerDisplayWeather } from "./customer-display-weather";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true
});

function useWallClock() {
  const [label, setLabel] = useState(() => timeFormatter.format(new Date()));

  useEffect(() => {
    let interval: number | undefined;

    const tick = () => {
      setLabel(timeFormatter.format(new Date()));
    };

    const now = new Date();
    const msUntilNextMinute = 60_000 - (now.getSeconds() * 1_000 + now.getMilliseconds());
    const timeout = window.setTimeout(() => {
      tick();
      interval = window.setInterval(tick, 60_000);
    }, msUntilNextMinute);

    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, []);

  return label;
}

// Brand wordmark: a paper cup of rolled ice cream — three upright curls with a
// strawberry on top — beside the stacked "Example / Kitchen" lettering. The whole
// ice-cream group (curls + strawberry) bobs together as one unit.
function CustomerDisplayWordmark() {
  return (
    <div className="customer-display-wordmark" aria-label="EXAMPLE KITCHEN rolled ice cream">
      <span className="customer-display-wordmark-cup" aria-hidden="true">
        <svg viewBox="0 0 72 78" width="68" height="74">
          <g className="customer-display-mark-group">
            <path className="customer-display-mark-roll customer-display-mark-roll-a" d="M16 36 V22 a7 7 0 0 1 14 0 V36 Z" />
            <path className="customer-display-mark-roll customer-display-mark-roll-c" d="M29 36 V16 a7 7 0 0 1 14 0 V36 Z" />
            <path className="customer-display-mark-roll customer-display-mark-roll-b" d="M42 36 V22 a7 7 0 0 1 14 0 V36 Z" />
            <path className="customer-display-mark-swirl" d="M20 23 a3 3 0 0 1 6 0" />
            <path className="customer-display-mark-swirl" d="M33 17 a3 3 0 0 1 6 0" />
            <path className="customer-display-mark-swirl" d="M46 23 a3 3 0 0 1 6 0" />
            <path className="customer-display-mark-leaf" d="M36 3.4 L31.6 8.4 L36 7 L40.4 8.4 Z" />
            <path className="customer-display-mark-berry" d="M30.4 11 Q30.4 6.4 36 6.4 Q41.6 6.4 41.6 11 Q41.6 17.8 36 21 Q30.4 17.8 30.4 11 Z" />
            <circle className="customer-display-mark-seed" cx="34" cy="10.4" r="0.62" />
            <circle className="customer-display-mark-seed" cx="38" cy="10.4" r="0.62" />
            <circle className="customer-display-mark-seed" cx="36" cy="12.6" r="0.62" />
            <circle className="customer-display-mark-seed" cx="33.5" cy="13.4" r="0.62" />
            <circle className="customer-display-mark-seed" cx="38.5" cy="13.4" r="0.62" />
            <circle className="customer-display-mark-seed" cx="36" cy="15.9" r="0.62" />
          </g>
          <path className="customer-display-mark-cup" d="M14 36 H58 L53.2 66 a4 4 0 0 1-4 3.4 H22.8 a4 4 0 0 1-4-3.4 Z" />
          <rect className="customer-display-mark-cup-rim" x="12" y="33.5" width="48" height="6.5" rx="3.25" />
          <path className="customer-display-mark-cup-band" d="M19 49 H53" />
        </svg>
      </span>
      <span className="customer-display-wordmark-text">
        <span className="customer-display-wordmark-rop">Example</span>
        <span className="customer-display-wordmark-rollo">Kitchen</span>
      </span>
    </div>
  );
}

export function CustomerDisplayHeader({
  weatherConfig
}: {
  weatherConfig: CustomerDisplayWeatherSettings | null;
}) {
  const clock = useWallClock();

  return (
    <header className="customer-display-topbar">
      <div className="customer-display-brand">
        <CustomerDisplayWordmark />
        <span className="customer-display-kicker">Pickup Orders</span>
      </div>
      <div className="customer-display-topbar-meta">
        <CustomerDisplayWeather config={weatherConfig} />
        <time className="customer-display-clock" aria-label="Current time">
          {clock}
        </time>
      </div>
    </header>
  );
}
