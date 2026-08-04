"use client";

import { useSyncExternalStore } from "react";

const LOCATION = "Anytown, ST";

function formatNow(): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  }).format(now);
  return `${date} · ${time} · ${LOCATION}`;
}

function subscribe(onChange: () => void): () => void {
  const id = setInterval(onChange, 60_000);
  return () => clearInterval(id);
}

export function HubClock() {
  const label = useSyncExternalStore(subscribe, formatNow, () => LOCATION);
  return <span suppressHydrationWarning>{label}</span>;
}
