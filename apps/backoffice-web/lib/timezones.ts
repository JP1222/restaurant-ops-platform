// US store timezones offered in the settings UI (store-hours panel + store
// create). A curated short list, not the full IANA database — the brand operates
// US malls. `Location.timezone` itself accepts any IANA string; this is only the
// picker's options.
export const STORE_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

// The brand's home zone — the sensible default when creating the first/next store.
export const DEFAULT_STORE_TIMEZONE = "America/Chicago";

// Options for a tz <Select>, ensuring `current` stays selectable even if it isn't
// in the curated list (e.g. a value saved before the list changed) — without
// duplicating it.
export function timezoneOptions(current: string): string[] {
  return (STORE_TIMEZONES as readonly string[]).includes(current)
    ? [...STORE_TIMEZONES]
    : [current, ...STORE_TIMEZONES];
}
