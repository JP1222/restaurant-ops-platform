/**
 * Store-hours helpers for the ordering app. Reads the hours from the brand
 * SSOT (`brand.hours`), which mirrors the marketing-site's published hours, so
 * the header status pill can never drift from the real schedule.
 */
import { brand } from "./brand";

/** Format a 24-hour number as a compact pill label: 20 -> "8pm", 10 -> "10am", 12 -> "12pm". */
export function formatHour(hour24: number): string {
  const period = hour24 < 12 || hour24 === 24 ? "am" : "pm";
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}${period}`;
}

/**
 * Project an absolute instant onto the store's wall clock (`brand.hours.timeZone`)
 * so open/closed is judged in the shop's timezone, not the visitor's device.
 * `Intl` resolves the correct UTC offset including DST.
 */
export function storeLocalParts(now: Date): { day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: brand.hours.timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";

  const dayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const rawHour = Number(get("hour"));
  return {
    day: dayIndex[get("weekday")] ?? 0,
    hour: rawHour === 24 ? 0 : rawHour, // hour12:false can render midnight as "24"
    minute: Number(get("minute")),
  };
}

export type StoreStatus = {
  /** Whether the shop is open right now (drives the dot color via `.storestat.closed`). */
  open: boolean;
  /** Short header label, e.g. "Open · closes 8pm" or "Closed · opens 10am tomorrow". */
  label: string;
};

/** `[openHour, closeHour]` for a `Date.getDay()` index, with a guaranteed tuple under `noUncheckedIndexedAccess`. */
function hoursForDay(day: number): readonly [number, number] {
  return brand.hours.week[((day % 7) + 7) % 7] ?? [10, 20];
}

/**
 * Decide whether the Anytown store is open at `now` and build the header
 * label from the brand SSOT. Hours are on the hour, so an hour-granular
 * comparison is exact (8:30pm -> hour 20 -> closed, matching the 8pm close).
 *
 * The store operates 7 days/week, so "after close" always reopens tomorrow.
 */
export function storeStatus(now: Date): StoreStatus {
  const { day, hour } = storeLocalParts(now);
  const [openHour, closeHour] = hoursForDay(day);

  if (hour >= openHour && hour < closeHour) {
    return { open: true, label: `Open · closes ${formatHour(closeHour)}` };
  }
  if (hour < openHour) {
    return { open: false, label: `Closed · opens ${formatHour(openHour)}` };
  }
  const [nextOpenHour] = hoursForDay(day + 1);
  return { open: false, label: `Closed · opens ${formatHour(nextOpenHour)} tomorrow` };
}
