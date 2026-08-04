export type Lang = "es" | "en";

// Redesign (design handoff): Home regroups into Movimientos + Catálogo. The scan
// invoice flow and the Artículos catalog are new top-level screens; the old
// stand-alone "86", "additem", and "edititem" screens are subsumed by the Items
// screen (item detail consolidates 86 / recount / waste; "＋ Nuevo" + Editar live
// there). Item detail is NOT a screen — it's a sub-state inside Items (see `sel`
// in crew-app.tsx). "scan-barcode" is the barcode stock-adjust flow (design
// handoff §8): scan an item's code → nudge on_hand by a signed amount. Distinct
// from "scan" (the AI invoice scanner).
export type Screen = "home" | "scan" | "items" | "receive" | "waste" | "recount" | "scan-barcode";

// Login/me read shape. Deliberately NOT `InventoryEmployee` from contracts:
// inventory-api's crew-auth `publicEmployee()` strips the roster row down to
// exactly these six fields, so the floor session never sees `active`,
// `created_at`, or `updated_at`. `InventoryEmployee` is the manager-roster
// contract (GET /api/admin/crew); using it here would let code read fields the
// crew payload never carries.
export type Employee = {
  id: string;
  name: string;
  role: string;
  shift: string;
  initials: string;
  color: string;
};
