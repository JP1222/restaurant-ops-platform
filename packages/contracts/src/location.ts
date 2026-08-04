import { z } from "zod";

// POS-agnostic store identity exposed to the backoffice UI (ADR-0018). The
// canonical record lives in db-kds `Location`; this is the BFF -> browser
// shape. Named `StoreLocation` to avoid colliding with the DOM `Location`.
export const StoreLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  active: z.boolean(),
  // The bound POS store-account (db-kds `CloverMerchant.id`), or null when the
  // store has no POS connection yet. Drives the onboarding "Bind POS" action and
  // the analytics scope resolver (an unbound store deliberately shows "no data"
  // rather than another store's numbers). 1 location maps 1->N merchants in the
  // model; this is the canonical (earliest-connected) one.
  merchantId: z.string().nullable(),
});
export type StoreLocation = z.infer<typeof StoreLocationSchema>;

export const StoreLocationListResponseSchema = z.object({
  locations: z.array(StoreLocationSchema),
});
export type StoreLocationListResponse = z.infer<typeof StoreLocationListResponseSchema>;

// Operator-editable fields for a store. Only the display name is editable from
// the Locations admin page today; slug/timezone/POS binding are managed
// elsewhere (ADR-0018).
export const StoreLocationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type StoreLocationUpdate = z.infer<typeof StoreLocationUpdateSchema>;

// Fields required to create a new store from the Locations admin (multi-store
// onboarding, ADR-0018). The slug is derived server-side (deduped); hours seed to
// DEFAULT_STORE_HOURS at create and are edited later in Settings → Store Hours.
// Binding a POS account to the new store is a separate step (see docs/multi-location.md).
export const StoreLocationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64),
});
export type StoreLocationCreate = z.infer<typeof StoreLocationCreateSchema>;

export const StoreLocationResponseSchema = z.object({
  location: StoreLocationSchema,
});
export type StoreLocationResponse = z.infer<typeof StoreLocationResponseSchema>;

// An unbound store-account: a db-kds `CloverMerchant` row with no `locationId`,
// i.e. a connected POS waiting to be bound to a Location during onboarding
// (ADR-0018 deferred #1 / ADR-0019). `CloverMerchant` is the GENERIC store-account
// table, so this covers Clover and future non-Clover sources alike; `name` is the
// merchant's display name when known, else null (operators identify it by id).
export const UnlinkedMerchantSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  authStatus: z.string(),
  connectedAt: z.string(),
});
export type UnlinkedMerchant = z.infer<typeof UnlinkedMerchantSchema>;

export const UnlinkedMerchantListResponseSchema = z.object({
  merchants: z.array(UnlinkedMerchantSchema),
});
export type UnlinkedMerchantListResponse = z.infer<typeof UnlinkedMerchantListResponseSchema>;

// Bind a store-account (`CloverMerchant.id`) to a Location — the second half of
// store onboarding, after the Location is created. The bind only succeeds when
// the merchant is currently unbound, so it can never steal another store's POS.
export const StoreLocationBindSchema = z.object({
  merchantId: z.string().trim().min(1).max(32),
});
export type StoreLocationBind = z.infer<typeof StoreLocationBindSchema>;

// ── Store hours ─────────────────────────────────────────────────────────────
// Weekly opening hours, persisted on db-kds `Location.operatingHours` (Json). Each
// day is a single open/close window in store-local 24h "HH:MM", or null = closed.
// Multi-store (ADR-0018): hours live per-Location, so each store keeps its own.

const TIME_24H = /^([01]\d|2[0-3]):[0-5]\d$/;

export const StoreDayHoursSchema = z
  .object({
    open: z.string().regex(TIME_24H, "time must be HH:MM (24-hour)"),
    close: z.string().regex(TIME_24H, "time must be HH:MM (24-hour)"),
  })
  .strict()
  .refine((d) => d.open < d.close, { message: "open must be before close" })
  .nullable();
export type StoreDayHours = z.infer<typeof StoreDayHoursSchema>;

// Sunday-first, matching JS Date.getDay() (0=Sun..6=Sat) and the Today page's
// WEEKDAY_LABEL ordering, so a weekday index maps straight to a key.
export const STORE_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type StoreWeekday = (typeof STORE_WEEKDAYS)[number];

export const StoreHoursSchema = z.object({
  sun: StoreDayHoursSchema,
  mon: StoreDayHoursSchema,
  tue: StoreDayHoursSchema,
  wed: StoreDayHoursSchema,
  thu: StoreDayHoursSchema,
  fri: StoreDayHoursSchema,
  sat: StoreDayHoursSchema,
});
export type StoreHours = z.infer<typeof StoreHoursSchema>;

// Seed default = the Anytown store: Mon–Sat 10:00–20:00, Sun 12:00–18:00.
// Used when a Location has no saved hours yet (and as the create-time default).
export const DEFAULT_STORE_HOURS: StoreHours = {
  sun: { open: "12:00", close: "18:00" },
  mon: { open: "10:00", close: "20:00" },
  tue: { open: "10:00", close: "20:00" },
  wed: { open: "10:00", close: "20:00" },
  thu: { open: "10:00", close: "20:00" },
  fri: { open: "10:00", close: "20:00" },
  sat: { open: "10:00", close: "20:00" },
};

// Read shape (GET /api/store-hours): the active store's hours + timezone.
// `source` flags whether these are a saved per-store record or the seed default.
export const StoreHoursResponseSchema = z.object({
  locationId: z.string().nullable(),
  name: z.string().nullable(),
  timezone: z.string(),
  hours: StoreHoursSchema,
  source: z.enum(["location", "default"]),
});
export type StoreHoursResponse = z.infer<typeof StoreHoursResponseSchema>;

// Write shape (PUT /api/store-hours).
export const StoreHoursUpdateSchema = z.object({
  timezone: z.string().trim().min(1).max(64),
  hours: StoreHoursSchema,
});
export type StoreHoursUpdate = z.infer<typeof StoreHoursUpdateSchema>;

// ── Pure derivations (shared by the editor, the BFF, and the dashboard) ──────

/** "10:00" -> "10:00 AM", "12:00" -> "12:00 PM", "18:30" -> "6:30 PM". */
export function formatTime12h(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

export interface TodayOpen {
  /** 24h open hour (0–23), for before/after-open comparisons. */
  hour: number;
  /** Open minute (0–59) — paired with `hour` so a 10:30 open compares correctly. */
  minute: number;
  /** "HH:MM" open time, store-local. */
  time: string;
  /** Display label, e.g. "10:00 AM". */
  label: string;
}

/**
 * The open time for a given weekday (0=Sun..6=Sat), or null when the store is
 * closed that day. Drives the dashboard's pre-open framing (it must know when
 * "today" actually opens, which differs by weekday — e.g. a noon Sunday).
 */
export function deriveTodayOpen(hours: StoreHours, weekday: number): TodayOpen | null {
  const key = STORE_WEEKDAYS[((Math.trunc(weekday) % 7) + 7) % 7];
  const day = key ? hours[key] : null;
  if (!day) return null;
  return {
    hour: Number(day.open.slice(0, 2)),
    minute: Number(day.open.slice(3, 5)),
    time: day.open,
    label: formatTime12h(day.open),
  };
}
