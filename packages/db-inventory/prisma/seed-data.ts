// Canonical demo dataset for local/dev seeding. Mirrors the design-handoff
// fixture currently inlined in apps/backoffice-web/lib/inventory/fixtures.ts.
// Lives here (not imported from the app) so the package depends only on
// contracts, never on a downstream app. Once Phase 4 wires backoffice to the
// API, the app fixture is retired and this becomes the single source.
import type { InventoryDataset } from "@rop/contracts";

// The demo items predate unit conversion, so they're authored WITHOUT the
// purchase->usage fields; seed.ts injects defaults (pack 1, purchase == cost) at
// parse time. Everything else matches the InventoryDataset contract exactly.
type SeedDataset = Omit<InventoryDataset, "items"> & {
  items: Array<
    Omit<InventoryDataset["items"][number], "purchase_unit" | "pack_qty" | "purchase_cost_cents">
  >;
};

export const SEED_DATASET: SeedDataset = {
  categories: [
    { id: "dairy", name: "Dairy & Cream", color: "amber" },
    { id: "powder", name: "Powders & Bases", color: "wheat" },
    { id: "topping", name: "Toppings", color: "violet" },
    { id: "fruit", name: "Fruit", color: "tomato" },
    { id: "sweetener", name: "Sweeteners", color: "pink" },
    { id: "packaging", name: "Cups & Packaging", color: "slate" },
    { id: "food", name: "Other Food", color: "mint" },
    { id: "supplies", name: "Supplies", color: "blue" }
  ],

  items: [
    { id: "sku-001", sku: "PRT-CHK-THI", name: "Chicken thigh, boneless", category: "food", unit: "lb", on_hand: 22, par_min: 30, par_max: 60, cost_cents: 320, vendor: "Sysco", shelf_days: 4, last_counted: "2026-05-19", flagged_86: false },
    { id: "sku-002", sku: "PRT-BEF-SRB", name: "Beef short rib", category: "food", unit: "lb", on_hand: 18, par_min: 15, par_max: 40, cost_cents: 750, vendor: "PFG", shelf_days: 5, last_counted: "2026-05-20", flagged_86: false },
    { id: "sku-003", sku: "PRT-PRK-BLY", name: "Pork belly, skin-on", category: "food", unit: "lb", on_hand: 12, par_min: 20, par_max: 50, cost_cents: 580, vendor: "Sysco", shelf_days: 6, last_counted: "2026-05-20", flagged_86: false },
    { id: "sku-004", sku: "PRT-TNA-AHI", name: "Ahi tuna, sushi grade", category: "food", unit: "lb", on_hand: 3, par_min: 5, par_max: 15, cost_cents: 2200, vendor: "True World", shelf_days: 3, last_counted: "2026-05-21", flagged_86: false },
    { id: "sku-005", sku: "PRT-SLM-FLT", name: "Salmon fillet", category: "food", unit: "lb", on_hand: 9, par_min: 10, par_max: 25, cost_cents: 1280, vendor: "True World", shelf_days: 3, last_counted: "2026-05-20", flagged_86: false },
    { id: "sku-006", sku: "PRT-SHR-21", name: "Shrimp, 21/25 ct", category: "food", unit: "lb", on_hand: 14, par_min: 8, par_max: 24, cost_cents: 980, vendor: "PFG", shelf_days: 7, last_counted: "2026-05-19", flagged_86: false },
    { id: "sku-007", sku: "PRT-TOF-FRM", name: "Tofu, firm block", category: "food", unit: "block", on_hand: 34, par_min: 20, par_max: 60, cost_cents: 240, vendor: "Hung Vuong", shelf_days: 14, last_counted: "2026-05-18", flagged_86: false },

    { id: "sku-010", sku: "PRD-AVO-48", name: "Avocado, 48 ct case", category: "fruit", unit: "each", on_hand: 18, par_min: 24, par_max: 96, cost_cents: 85, vendor: "Produce Pros", shelf_days: 5, last_counted: "2026-05-21", flagged_86: false },
    { id: "sku-011", sku: "PRD-CUC-ENG", name: "Cucumber, English", category: "fruit", unit: "lb", on_hand: 24, par_min: 10, par_max: 30, cost_cents: 160, vendor: "Produce Pros", shelf_days: 7, last_counted: "2026-05-20", flagged_86: false },
    { id: "sku-012", sku: "PRD-GIN-FRS", name: "Ginger root, fresh", category: "fruit", unit: "lb", on_hand: 9, par_min: 5, par_max: 15, cost_cents: 340, vendor: "Produce Pros", shelf_days: 21, last_counted: "2026-05-18", flagged_86: false },
    { id: "sku-013", sku: "PRD-SCL-BCH", name: "Scallion, bunch", category: "fruit", unit: "bunch", on_hand: 28, par_min: 12, par_max: 40, cost_cents: 95, vendor: "Produce Pros", shelf_days: 7, last_counted: "2026-05-21", flagged_86: false },
    { id: "sku-014", sku: "PRD-MNG-08", name: "Mango, ataulfo case", category: "fruit", unit: "case", on_hand: 2, par_min: 4, par_max: 12, cost_cents: 2400, vendor: "Produce Pros", shelf_days: 7, last_counted: "2026-05-19", flagged_86: true },
    { id: "sku-015", sku: "PRD-LIM-200", name: "Lime, persian", category: "fruit", unit: "each", on_hand: 64, par_min: 50, par_max: 200, cost_cents: 18, vendor: "Produce Pros", shelf_days: 14, last_counted: "2026-05-20", flagged_86: false },
    { id: "sku-016", sku: "PRD-CIL-BCH", name: "Cilantro, bunch", category: "fruit", unit: "bunch", on_hand: 6, par_min: 10, par_max: 30, cost_cents: 110, vendor: "Produce Pros", shelf_days: 5, last_counted: "2026-05-21", flagged_86: false },
    { id: "sku-017", sku: "PRD-CAB-NPA", name: "Cabbage, napa", category: "fruit", unit: "lb", on_hand: 38, par_min: 20, par_max: 60, cost_cents: 140, vendor: "Produce Pros", shelf_days: 10, last_counted: "2026-05-19", flagged_86: false },

    { id: "sku-020", sku: "DRY-EGG-30", name: "Egg, large, 30 ct flat", category: "dairy", unit: "flat", on_hand: 22, par_min: 12, par_max: 36, cost_cents: 680, vendor: "Sysco", shelf_days: 21, last_counted: "2026-05-20", flagged_86: false },
    { id: "sku-021", sku: "DRY-BTR-LB", name: "Butter, unsalted", category: "dairy", unit: "lb", on_hand: 14, par_min: 8, par_max: 24, cost_cents: 520, vendor: "Sysco", shelf_days: 30, last_counted: "2026-05-18", flagged_86: false },
    { id: "sku-022", sku: "DRY-CRM-QT", name: "Heavy cream, quart", category: "dairy", unit: "qt", on_hand: 5, par_min: 6, par_max: 18, cost_cents: 480, vendor: "Sysco", shelf_days: 14, last_counted: "2026-05-20", flagged_86: false },

    { id: "sku-030", sku: "DRY-RIC-50", name: "Rice, jasmine, 50 lb", category: "food", unit: "bag", on_hand: 6, par_min: 3, par_max: 8, cost_cents: 4280, vendor: "Wismettac", shelf_days: 540, last_counted: "2026-05-15", flagged_86: false },
    { id: "sku-031", sku: "DRY-PNK-05", name: "Panko breadcrumbs, 5 lb", category: "food", unit: "bag", on_hand: 4, par_min: 2, par_max: 8, cost_cents: 1280, vendor: "Wismettac", shelf_days: 180, last_counted: "2026-05-17", flagged_86: false },
    { id: "sku-032", sku: "DRY-TMP-05", name: "Tempura flour, 5 lb", category: "food", unit: "bag", on_hand: 6, par_min: 3, par_max: 10, cost_cents: 980, vendor: "Wismettac", shelf_days: 240, last_counted: "2026-05-17", flagged_86: false },
    { id: "sku-033", sku: "DRY-NOR-100", name: "Nori sheet, 100 ct", category: "food", unit: "pack", on_hand: 7, par_min: 4, par_max: 12, cost_cents: 2200, vendor: "Wismettac", shelf_days: 365, last_counted: "2026-05-16", flagged_86: false },
    { id: "sku-034", sku: "DRY-SES-LB", name: "Sesame seed, toasted", category: "food", unit: "lb", on_hand: 4, par_min: 2, par_max: 6, cost_cents: 780, vendor: "Wismettac", shelf_days: 365, last_counted: "2026-05-15", flagged_86: false },

    { id: "sku-040", sku: "SCE-SOY-GAL", name: "Soy sauce, gallon", category: "sweetener", unit: "gal", on_hand: 5, par_min: 2, par_max: 6, cost_cents: 1480, vendor: "Wismettac", shelf_days: 540, last_counted: "2026-05-12", flagged_86: false },
    { id: "sku-041", sku: "SCE-SRR-28", name: "Sriracha, 28 oz", category: "sweetener", unit: "btl", on_hand: 11, par_min: 6, par_max: 18, cost_cents: 580, vendor: "Restaurant Depot", shelf_days: 540, last_counted: "2026-05-12", flagged_86: false },
    { id: "sku-042", sku: "SCE-SES-1L", name: "Sesame oil, 1 L", category: "sweetener", unit: "btl", on_hand: 6, par_min: 3, par_max: 8, cost_cents: 1280, vendor: "Wismettac", shelf_days: 365, last_counted: "2026-05-12", flagged_86: false },
    { id: "sku-043", sku: "SCE-MYO-GAL", name: "Kewpie mayo, gallon", category: "sweetener", unit: "gal", on_hand: 3, par_min: 2, par_max: 6, cost_cents: 3280, vendor: "Wismettac", shelf_days: 180, last_counted: "2026-05-12", flagged_86: false },
    { id: "sku-044", sku: "SCE-RVN-GAL", name: "Rice vinegar, gallon", category: "sweetener", unit: "gal", on_hand: 4, par_min: 2, par_max: 6, cost_cents: 1180, vendor: "Wismettac", shelf_days: 540, last_counted: "2026-05-12", flagged_86: false },
    { id: "sku-045", sku: "SCE-CHL-OIL", name: "Chili crisp, 6 oz", category: "sweetener", unit: "jar", on_hand: 1, par_min: 8, par_max: 24, cost_cents: 680, vendor: "Wismettac", shelf_days: 365, last_counted: "2026-05-19", flagged_86: false },

    { id: "sku-050", sku: "BEV-COK-CS", name: "Coke, 12 oz case", category: "powder", unit: "case", on_hand: 8, par_min: 4, par_max: 14, cost_cents: 1980, vendor: "Coca-Cola", shelf_days: 365, last_counted: "2026-05-14", flagged_86: false },
    { id: "sku-051", sku: "BEV-SPK-CS", name: "Sparkling water case", category: "powder", unit: "case", on_hand: 5, par_min: 3, par_max: 10, cost_cents: 1480, vendor: "Coca-Cola", shelf_days: 365, last_counted: "2026-05-14", flagged_86: false },
    { id: "sku-052", sku: "BEV-RTG-12", name: "Genmaicha tea bag, 100 ct", category: "powder", unit: "box", on_hand: 3, par_min: 2, par_max: 6, cost_cents: 1880, vendor: "Wismettac", shelf_days: 730, last_counted: "2026-05-10", flagged_86: false },

    { id: "sku-060", sku: "PKG-BWL-32", name: "Bowl, 32 oz kraft", category: "packaging", unit: "sleeve", on_hand: 14, par_min: 10, par_max: 40, cost_cents: 1240, vendor: "WebstaurantStore", shelf_days: 9999, last_counted: "2026-05-10", flagged_86: false },
    { id: "sku-061", sku: "PKG-LID-32", name: "Lid, 32 oz", category: "packaging", unit: "sleeve", on_hand: 18, par_min: 10, par_max: 40, cost_cents: 820, vendor: "WebstaurantStore", shelf_days: 9999, last_counted: "2026-05-10", flagged_86: false },
    { id: "sku-062", sku: "PKG-CHP-WD", name: "Chopsticks, paper wrap", category: "packaging", unit: "box", on_hand: 6, par_min: 4, par_max: 12, cost_cents: 2480, vendor: "WebstaurantStore", shelf_days: 9999, last_counted: "2026-05-10", flagged_86: false },
    { id: "sku-063", sku: "PKG-BAG-LG", name: "Carry-out bag, kraft, lg", category: "packaging", unit: "bundle", on_hand: 3, par_min: 6, par_max: 18, cost_cents: 1880, vendor: "WebstaurantStore", shelf_days: 9999, last_counted: "2026-05-10", flagged_86: false }
  ],

  recipes: [
    { id: "rcp-001", name: "Spicy Tuna Bowl", category: "Bowls", sell_cents: 1495, sold_today: 42, lines: [{ sku: "sku-004", qty: 0.25 }, { sku: "sku-010", qty: 0.5 }, { sku: "sku-013", qty: 0.15 }, { sku: "sku-041", qty: 0.03 }, { sku: "sku-043", qty: 0.02 }, { sku: "sku-030", qty: 0.012 }, { sku: "sku-060", qty: 0.04 }, { sku: "sku-061", qty: 0.04 }] },
    { id: "rcp-002", name: "Chicken Teriyaki Roll", category: "Rolls", sell_cents: 1295, sold_today: 38, lines: [{ sku: "sku-001", qty: 0.35 }, { sku: "sku-013", qty: 0.1 }, { sku: "sku-030", qty: 0.018 }, { sku: "sku-033", qty: 0.02 }, { sku: "sku-040", qty: 0.015 }] },
    { id: "rcp-003", name: "Pork Belly Bao", category: "Buns", sell_cents: 895, sold_today: 64, lines: [{ sku: "sku-003", qty: 0.18 }, { sku: "sku-011", qty: 0.06 }, { sku: "sku-013", qty: 0.08 }, { sku: "sku-041", qty: 0.02 }] },
    { id: "rcp-004", name: "Salmon Avocado Roll", category: "Rolls", sell_cents: 1395, sold_today: 31, lines: [{ sku: "sku-005", qty: 0.25 }, { sku: "sku-010", qty: 0.4 }, { sku: "sku-013", qty: 0.08 }, { sku: "sku-033", qty: 0.02 }, { sku: "sku-030", qty: 0.018 }] },
    { id: "rcp-005", name: "Tofu Crunch Bowl", category: "Bowls", sell_cents: 1195, sold_today: 18, lines: [{ sku: "sku-007", qty: 0.5 }, { sku: "sku-017", qty: 0.3 }, { sku: "sku-013", qty: 0.12 }, { sku: "sku-031", qty: 0.05 }, { sku: "sku-045", qty: 0.05 }] },
    { id: "rcp-006", name: "Shrimp Tempura Roll", category: "Rolls", sell_cents: 1495, sold_today: 29, lines: [{ sku: "sku-006", qty: 0.3 }, { sku: "sku-032", qty: 0.05 }, { sku: "sku-030", qty: 0.024 }, { sku: "sku-033", qty: 0.02 }] },
    { id: "rcp-007", name: "Beef Short Rib Bowl", category: "Bowls", sell_cents: 1695, sold_today: 24, lines: [{ sku: "sku-002", qty: 0.4 }, { sku: "sku-013", qty: 0.15 }, { sku: "sku-030", qty: 0.018 }, { sku: "sku-040", qty: 0.02 }] },
    { id: "rcp-008", name: "Mango Sticky Rice", category: "Sweets", sell_cents: 795, sold_today: 22, lines: [{ sku: "sku-014", qty: 0.08 }, { sku: "sku-030", qty: 0.018 }, { sku: "sku-022", qty: 0.05 }] }
  ],

  activity: [
    { at: "08:42", who: "Maya R.", action: "counted", what: "23 items in walk-in", note: "Variance: -2.4% vs theoretical" },
    { at: "08:28", who: "system", action: "86'd", what: "Mango, ataulfo case", note: "On-hand fell below 0.5x par" },
    { at: "07:55", who: "Diego L.", action: "received", what: "PO #1142 from Sysco", note: "7 of 9 lines matched, 1 short" },
    { id: "a-w1", at: "07:31", who: "Diego L.", action: "recorded waste", what: "1.2 lb salmon fillet", note: "Reason: prep error" },
    { at: "07:14", who: "Maya R.", action: "adjusted", what: "par for Ahi tuna -> 5/15", note: "Up from 4/12, weekend pacing" },
    { at: "22:08", who: "system", action: "closed", what: "Day 05-20 (yesterday)", note: "COGS $4,128.40 - 28.4% of net" }
  ],

  pos: [
    { id: "PO-1144", vendor: "Sysco", placed: "2026-05-21", expected: "2026-05-22", lines: 11, status: "in-transit", total_cents: 84720 },
    { id: "PO-1143", vendor: "Produce Pros", placed: "2026-05-21", expected: "2026-05-22", lines: 8, status: "submitted", total_cents: 31480 },
    { id: "PO-1142", vendor: "Sysco", placed: "2026-05-20", expected: "2026-05-21", lines: 9, status: "received", total_cents: 62110 },
    { id: "PO-1141", vendor: "True World", placed: "2026-05-20", expected: "2026-05-22", lines: 4, status: "in-transit", total_cents: 41280 },
    { id: "PO-1140", vendor: "Wismettac", placed: "2026-05-19", expected: "2026-05-23", lines: 14, status: "submitted", total_cents: 103480 },
    { id: "PO-1139", vendor: "WebstaurantStore", placed: "2026-05-18", expected: "2026-05-22", lines: 6, status: "in-transit", total_cents: 28940 }
  ],

  counts: [
    { id: "CT-308", date: "2026-05-21", who: "Maya R.", scope: "Walk-in cooler", items: 23, variance_pct: -2.4, variance_cents: -12480, status: "closed" },
    { id: "CT-307", date: "2026-05-21", who: "Diego L.", scope: "Dry storage", items: 18, variance_pct: 0.8, variance_cents: 3120, status: "closed" },
    { id: "CT-306", date: "2026-05-20", who: "Maya R.", scope: "Freezer", items: 11, variance_pct: -1.1, variance_cents: -4280, status: "closed" },
    { id: "CT-305", date: "2026-05-19", who: "Diego L.", scope: "Full inventory", items: 96, variance_pct: -3.6, variance_cents: -28440, status: "closed" },
    { id: "CT-304", date: "2026-05-21", who: "Maya R.", scope: "Sauce station", items: 7, variance_pct: null, variance_cents: null, status: "in-progress" }
  ],

  cogs_target_pct: 28.0,

  vendors: [
    { id: "v-sysco", name: "Sysco", type: "Broadliner", contact: "Marcus Webb", phone: "(901) 555-0142", email: "orders.tn@sysco.com", account: "YR-0918-3", terms: "Net 30", min_order_cents: 25000, cutoff: "4:00 PM CT", delivery_days: ["Mon", "Wed", "Fri"], categories: ["food", "dairy", "fruit", "packaging"], fill_rate: 0.962, on_time: 0.91, price_stability: 0.88, credits_90d: 2, spend_30d: 1842030, trend_4w: [412000, 458000, 471000, 501030], preferred: true, tags: ["primary", "contracted"] },
    { id: "v-pfg", name: "PFG (Performance)", type: "Broadliner", contact: "Aisha Carter", phone: "(901) 555-0387", email: "anytownorders@pfgc.com", account: "M-44218", terms: "Net 21", min_order_cents: 35000, cutoff: "3:30 PM CT", delivery_days: ["Tue", "Thu"], categories: ["food", "food", "packaging"], fill_rate: 0.918, on_time: 0.78, price_stability: 0.81, credits_90d: 5, spend_30d: 642380, trend_4w: [174000, 138000, 152000, 178380], preferred: false, tags: ["secondary", "backup"] },
    { id: "v-trueworld", name: "True World Foods", type: "Specialty", contact: "Kenji Sato", phone: "(901) 555-0419", email: "anytown@trueworld.com", account: "TWF-MEM-074", terms: "Net 14", min_order_cents: 50000, cutoff: "12:00 PM CT (T/Th)", delivery_days: ["Wed", "Fri"], categories: ["food"], fill_rate: 0.978, on_time: 0.94, price_stability: 0.72, credits_90d: 1, spend_30d: 389440, trend_4w: [78000, 92000, 104000, 115440], preferred: true, tags: ["seafood", "contracted"] },
    { id: "v-produce", name: "Produce Pros", type: "Specialty", contact: "Ramon Delgado", phone: "(901) 555-0571", email: "tn-orders@producepros.com", account: "PP-1188", terms: "Net 7", min_order_cents: 15000, cutoff: "9:00 PM CT (next-day)", delivery_days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], categories: ["fruit"], fill_rate: 0.944, on_time: 0.96, price_stability: 0.62, credits_90d: 8, spend_30d: 248910, trend_4w: [58000, 62000, 64000, 64910], preferred: true, tags: ["local", "next-day"] },
    { id: "v-wismettac", name: "Wismettac", type: "Specialty", contact: "Yuki Tanaka", phone: "(770) 555-0228", email: "southeast@wismettac.com", account: "WIS-SE-2103", terms: "Net 30", min_order_cents: 80000, cutoff: "Thursday for next Wed", delivery_days: ["Wed"], categories: ["food", "sweetener"], fill_rate: 0.989, on_time: 0.99, price_stability: 0.94, credits_90d: 0, spend_30d: 418720, trend_4w: [102000, 98000, 108000, 110720], preferred: true, tags: ["asian-pantry", "weekly"] },
    { id: "v-webstaur", name: "WebstaurantStore", type: "Equipment", contact: "online", phone: "(717) 392-7472", email: "support@webstaurantstore.com", account: "WS-2204881", terms: "Net 0 (CC)", min_order_cents: 0, cutoff: "Order online", delivery_days: ["UPS 2-day"], categories: ["packaging"], fill_rate: 0.997, on_time: 0.84, price_stability: 0.78, credits_90d: 1, spend_30d: 84210, trend_4w: [21000, 19000, 22000, 22210], preferred: false, tags: ["online", "disposables"] },
    { id: "v-coke", name: "Coca-Cola", type: "Beverage DSD", contact: "Brian Lowell", phone: "(901) 555-0944", email: "brian.lowell@cocacola.com", account: "CCB-9928-MEM", terms: "Net 14", min_order_cents: 18000, cutoff: "Auto-replenish", delivery_days: ["Tue"], categories: ["powder"], fill_rate: 1.0, on_time: 0.98, price_stability: 0.96, credits_90d: 0, spend_30d: 118400, trend_4w: [28000, 30000, 30000, 30400], preferred: true, tags: ["DSD", "auto-stock"] }
  ],

  vendor_quotes: [
    { sku: "sku-001", quotes: [{ vid: "v-sysco", cents: 320, primary: true }, { vid: "v-pfg", cents: 335 }, { vid: "v-trueworld", cents: 312 }] },
    { sku: "sku-002", quotes: [{ vid: "v-pfg", cents: 750, primary: true }, { vid: "v-sysco", cents: 778 }] },
    { sku: "sku-003", quotes: [{ vid: "v-sysco", cents: 580, primary: true }, { vid: "v-pfg", cents: 610 }] },
    { sku: "sku-004", quotes: [{ vid: "v-trueworld", cents: 2200, primary: true }, { vid: "v-sysco", cents: 2480 }] },
    { sku: "sku-005", quotes: [{ vid: "v-trueworld", cents: 1280, primary: true }, { vid: "v-sysco", cents: 1340 }] },
    { sku: "sku-010", quotes: [{ vid: "v-produce", cents: 85, primary: true }, { vid: "v-sysco", cents: 96 }] },
    { sku: "sku-030", quotes: [{ vid: "v-wismettac", cents: 4280, primary: true }, { vid: "v-sysco", cents: 4520 }] },
    { sku: "sku-040", quotes: [{ vid: "v-wismettac", cents: 1480, primary: true }, { vid: "v-sysco", cents: 1580 }] }
  ],

  waste_reasons: [
    { id: "spoilage", label: "Spoilage / Expired", color: "#a16207", needs_photo_over_cents: 2000 },
    { id: "prep", label: "Prep error", color: "#b45309", needs_photo_over_cents: 5000 },
    { id: "cook", label: "Cook error / Burn", color: "#dc2626", needs_photo_over_cents: 5000 },
    { id: "return", label: "Customer return", color: "#7c3aed", needs_photo_over_cents: 0 },
    { id: "quality", label: "Quality reject", color: "#0284c7", needs_photo_over_cents: 0 },
    { id: "drop", label: "Drop / Breakage", color: "#475569", needs_photo_over_cents: 5000 },
    { id: "theft", label: "Theft / Loss", color: "#1e293b", needs_photo_over_cents: 0 },
    { id: "over", label: "Overproduction", color: "#65a30d", needs_photo_over_cents: 10000 }
  ],

  waste_log: [
    { id: "w-318", at: "2026-05-21 07:31", who: "Diego L.", sku: "sku-005", qty: 1.2, reason: "prep", notes: "Skinning slip, dorsal cut", photo: true, approved: true },
    { id: "w-317", at: "2026-05-21 11:42", who: "Maya R.", sku: "sku-010", qty: 3, reason: "spoilage", notes: "Brown spots through-and-through, 3 avos", photo: true, approved: true },
    { id: "w-316", at: "2026-05-21 12:08", who: "Diego L.", sku: "sku-016", qty: 2, reason: "quality", notes: "Wilted on arrival from Produce Pros", photo: false, approved: true },
    { id: "w-315", at: "2026-05-21 14:55", who: "Sam K.", sku: "sku-001", qty: 0.4, reason: "cook", notes: "Overcooked batch - grill temp too high", photo: true, approved: true },
    { id: "w-314", at: "2026-05-21 15:30", who: "Maya R.", sku: "sku-045", qty: 1, reason: "drop", notes: "Jar fell from prep shelf", photo: true, approved: false },
    { id: "w-313", at: "2026-05-21 18:12", who: "Sam K.", sku: "sku-006", qty: 0.8, reason: "return", notes: "Customer comp - wrong allergen on ticket", photo: false, approved: true },
    { id: "w-312", at: "2026-05-20 21:40", who: "Maya R.", sku: "sku-022", qty: 0.5, reason: "spoilage", notes: "Cream curdled, near best-by", photo: false, approved: true },
    { id: "w-311", at: "2026-05-20 19:22", who: "Diego L.", sku: "sku-007", qty: 1, reason: "over", notes: "Pre-portioned cubes left at close", photo: false, approved: true },
    { id: "w-310", at: "2026-05-20 14:08", who: "Sam K.", sku: "sku-002", qty: 0.6, reason: "prep", notes: "Bones missed in trim - refired", photo: true, approved: true },
    { id: "w-309", at: "2026-05-20 12:30", who: "Maya R.", sku: "sku-013", qty: 4, reason: "spoilage", notes: "Slimy from cooler - back of stack", photo: true, approved: true }
  ],

  waste_settings: {
    photo_required_over_cents: 2500,
    manager_approval_over_cents: 5000
  }
};
