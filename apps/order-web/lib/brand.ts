/**
 * Single source of truth for the Example Kitchen brand in the ordering app.
 * Visual tokens (colors/shadows/radii) live in app/globals.css; this holds
 * the copy + the cart-side tax estimate.
 */
export const brand = {
  name: "Example Kitchen",
  fullName: "Example Kitchen",
  tagline: "Fresh. Fun. Rolled.",
  subTagline: "You choose. We roll.",
  location: "Anytown, ST",

  colors: {
    pink: "#EC1E79",
    pinkSoft: "#FCE4EC",
    green: "#A6CE39",
    orange: "#F58220",
    ink: "#1A1A1A",
    cream: "#FFF8F2",
  },

  /**
   * Anytown local + state sales tax (2025): 9.75%. Used only for the
   * cart-side estimate. The POS applies the merchant's configured tax at
   * checkout, so the final charge is authoritative regardless.
   */
  taxRate: 0.0975,

  /**
   * Anytown store hours, the single source of truth for the ordering app.
   * Mirrors the marketing-site's schema.org `openingHoursSpecification`
   * (apps/marketing-site/src/index.html): Mon–Sat 10:00–20:00, Sun 12:00–18:00.
   *
   * `week` is indexed by `Date.getDay()` (0 = Sunday … 6 = Saturday); each
   * entry is `[openHour, closeHour]` in 24-hour store-local time. The store is
   * in Anytown (`America/Chicago`), so open/closed is judged in that zone — a
   * customer ordering from another timezone still sees the shop's real state.
   */
  hours: {
    timeZone: "America/Chicago",
    week: [
      [12, 18], // Sun
      [10, 20], // Mon
      [10, 20], // Tue
      [10, 20], // Wed
      [10, 20], // Thu
      [10, 20], // Fri
      [10, 20], // Sat
    ],
  },
} as const;

export type Brand = typeof brand;
