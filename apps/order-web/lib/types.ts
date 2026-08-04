/**
 * Customer-ordering DTOs. These are deliberately **POS-neutral** — no
 * Clover/Square/Toast-specific fields leak in here. The mocked `lib/api.ts`
 * speaks these shapes today; when the real backend lands, these ideally
 * migrate into `packages/contracts` and the POS adapter maps onto them.
 */

export type Money = number; // dollars, e.g. 7.99

export interface Modifier {
  id: string;
  name: string; // e.g. "Strawberry", "Oreo crumble", "Waffle bowl"
  priceDelta: Money; // 0 for free toppings, positive for upgrades
  group: string; // e.g. "Base", "Mix-in", "Topping", "Vessel"
}

/**
 * Flavor key — selects the radial-gradient swatch used as a stand-in for a
 * product photo (see `flavorGradient()` in lib/flavors.ts). When real photos
 * exist, this can be ignored in favor of imageUrl.
 */
export type FlavorKey =
  | "oreo" | "strawberry" | "chocolate" | "mango" | "M&M" | "condensed"
  | "taro" | "matcha" | "coconut" | "thai" | "milk" | "jasmine"
  | "blueberry" | "lychee" | "honeydew" | "vanilla";

export interface ModifierGroup {
  id: string;
  name: string; // "Choose your vessel", "Pick 2 mix-ins"
  minSelections: number;
  maxSelections: number;
  modifiers: Modifier[];
}

export interface MenuItem {
  id: string;
  name: string;
  description?: string;
  tagline?: string; // short marketing line, e.g. "Vanilla base + Oreo mix-in"
  price: Money;
  imageUrl?: string;
  flavor?: FlavorKey; // gradient swatch key when no imageUrl is set
  number?: string; // signature roll number, e.g. "#1"
  tags?: string[]; // ["BEST SELLER"], ["NEW"], ["FAN FAV"]
  category: string;
  modifierGroups: ModifierGroup[];
  available: boolean;
}

export interface Menu {
  categories: string[];
  items: MenuItem[];
}

export interface CartLine {
  /** Stable client-generated id so the same item with different mods is a
   *  separate cart line. */
  lineId: string;
  itemId: string;
  itemName: string;
  unitPrice: Money; // base + modifier deltas, in dollars
  quantity: number;
  modifiers: { id: string; name: string; priceDelta: Money }[];
  notes?: string;
  flavor?: FlavorKey;
  imageUrl?: string;
}

export interface OrderRequest {
  customerName: string; // pickup-ticket label, NOT the cardholder
  customerPhone?: string;
  customerEmail?: string;
  notes?: string;
  lines: CartLine[];
}

export interface OrderResponse {
  orderId: string; // the priced draft id — pass to api.checkout()
  ticketNumber: string; // short human-friendly number, e.g. "R-042"
  totals: {
    subtotal: Money;
    tax: Money;
    total: Money;
  };
  /** Null in the in-page Clover hosted-iframe flow (card is captured on this
   *  page, no off-site redirect). Retained nullable for a future same-origin
   *  confirmation path / Hosted-Checkout fallback — mirrors
   *  CreateOrderResponse.checkoutUrl in packages/contracts. */
  checkoutUrl?: string | null;
  /** Opaque correlation id used to reconcile a redirect-back with the order the
   *  POS creates. Undefined/null when not needed. */
  correlationId?: string | null;
}

/**
 * Charge a priced draft. POS-neutral: `paymentToken` is opaque (a Clover
 * `clv_…` value today), never named after a processor — the UI doesn't know
 * which POS minted it.
 */
export interface OrderCheckoutRequest {
  orderId: string; // the draft id from OrderResponse
  paymentToken: string; // single-use token from the hosted iframe
  tip?: Money; // dollars; defaults to 0 (no tip selector yet — design-brief §7.5)
}

/** Result of a successful charge — order is paid and on its way to the KDS. */
export interface OrderConfirmation {
  orderId: string;
  ticketNumber: string;
  state: OrderStatus["state"];
  totals: {
    subtotal: Money;
    tax: Money;
    tip: Money;
    total: Money;
  };
  updatedAt: string;
}

export interface OrderStatus {
  orderId: string;
  ticketNumber: string;
  state:
    | "pending_payment"
    | "paid"
    | "preparing"
    | "ready"
    | "completed"
    | "cancelled";
  updatedAt: string;
}

/** Real-time pickup wait time from the kitchen queue. */
export interface QueueEstimate {
  /** Estimated minutes until the customer's order is ready. */
  minutes: number;
  /** How many tickets are currently ahead. */
  queueDepth: number;
  /** ISO timestamp the estimate was computed at. */
  asOf: string;
  /** Where the number came from. "fallback" means the backend was unreachable. */
  source: "live" | "fallback";
}
