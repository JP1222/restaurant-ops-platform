#!/usr/bin/env node
// Idempotent seeder for the Clover SANDBOX test catalog (merchant QZPHD754…).
//
// Builds the Example Kitchen test menu (rolled ice cream / bubble tea / smoothie /
// drinks) plus the "Build a Roll" modifier groups, shaped so kds-api's
// normalize-menu.ts renders it correctly: every item is associated to a
// category, and "Customize Your Own Roll" is linked to the modifier groups.
//
// Idempotent: re-running only creates what's missing (items keyed by
// name+category, modifiers by name within their group). Safe to run repeatedly.
//
// Usage (sandbox creds come from Infisical dev — never hardcoded here):
//   CLOVER_SANDBOX_ACCESS_TOKEN=… CLOVER_SANDBOX_MERCHANT_ID=… \
//     node scripts/seed-clover-sandbox-menu.mjs
// or via the repo's secret wrapper:
//   ./scripts/with-secrets.sh node scripts/seed-clover-sandbox-menu.mjs
//
// SANDBOX ONLY. Refuses to run against the production Clover host.

const BASE = process.env.CLOVER_BASE_URL ?? "https://apisandbox.dev.clover.com";
const TOKEN = process.env.CLOVER_SANDBOX_ACCESS_TOKEN ?? process.env.CLOVER_TOKEN;
const MID = process.env.CLOVER_SANDBOX_MERCHANT_ID ?? process.env.CLOVER_MERCHANT_ID;

if (!TOKEN || !MID) {
  console.error("Missing CLOVER_SANDBOX_ACCESS_TOKEN or CLOVER_SANDBOX_MERCHANT_ID in env.");
  process.exit(1);
}
if (!BASE.includes("sandbox")) {
  console.error(`Refusing to run: CLOVER_BASE_URL is not a sandbox host (${BASE}).`);
  process.exit(1);
}

const root = `${BASE}/v3/merchants/${MID}`;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let created = 0;
let reused = 0;

async function api(method, path, body) {
  const res = await fetch(`${root}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getAll(path) {
  // Clover paginates; for a small test catalog one page (limit 1000) is enough.
  const data = await api("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1000`);
  return data?.elements ?? [];
}

// ── Menu definition ────────────────────────────────────────────────────────
const ROLLED = "Rolled Ice Cream";
const BUBBLE = "Bubble Tea";
const SMOOTHIE = "Smoothie";
const DRINKS = "Drinks & Extras";

const categories = [ROLLED, BUBBLE, SMOOTHIE, DRINKS];

// price is integer cents
const items = [
  // Rolled — Classic / Specials $6.99
  ...["Vanilla", "Strawberry", "Chocolate", "Mango", "Coconut", "Customize Your Own Roll"].map(
    (name) => ({ name, price: 699, category: ROLLED }),
  ),
  ...[
    "#1 Cookies & Cream",
    "#2 Strawberry Cheesecake",
    "#3 Choco Oreo",
    "#4 Mango Strawberry",
    "#5 Coconut M&M",
    "#6 Vanilla Cheesecake",
  ].map((name) => ({ name, price: 699, category: ROLLED })),
  // Rolled — Example Kitchen Signature $7.99
  ...["Strawberry Crumble", "Waffle Bowl Classic"].map((name) => ({
    name,
    price: 799,
    category: ROLLED,
  })),
  // Rolled — Premium
  { name: "Dubai Chocolate Supreme", price: 1099, category: ROLLED },

  // Bubble Tea $5.99
  ...[
    "Bubble Milk Tea",
    "Taro",
    "Thai",
    "Jasmine",
    "Lychee",
    "Mango",
    "Strawberry",
    "Blueberry",
    "Honeydew",
    "Coconut",
    "Red Bean",
  ].map((name) => ({ name, price: 599, category: BUBBLE })),

  // Smoothie $5.99
  ...["Vanilla", "Chocolate", "Strawberry", "Mango", "Blueberry", "Honeydew", "Coconut"].map(
    (name) => ({ name, price: 599, category: SMOOTHIE }),
  ),

  // Drinks & Extras
  { name: "Coffee", price: 169, category: DRINKS },
  { name: "Iced Tea", price: 219, category: DRINKS },
  { name: "Ice Thai Tea", price: 219, category: DRINKS },
  { name: "Ice Chocolate", price: 219, category: DRINKS },
  { name: "Starbucks Frappuccino", price: 350, category: DRINKS },
  { name: "Bottled Drink", price: 229, category: DRINKS },
  { name: "Bottled Water", price: 139, category: DRINKS },
  { name: "Cup of Ice", price: 99, category: DRINKS },
];

// Build-a-Roll modifier groups. price = upcharge in cents (0 = free choice).
const modifierGroups = [
  {
    name: "Base 底味",
    minRequired: 1,
    maxAllowed: 1,
    modifiers: ["Vanilla", "Strawberry", "Chocolate", "Mango", "Coconut"].map((n) => ({
      name: n,
      price: 0,
    })),
  },
  {
    name: "Mix-ins 拌入",
    minRequired: 0,
    maxAllowed: 3,
    modifiers: [
      "Banana",
      "Blueberry",
      "Brownie",
      "Cheesecake",
      "Mango",
      "Oreo Cookie",
      "Peanut Butter",
      "Pineapple",
      "Strawberry",
    ].map((n) => ({ name: n, price: 0 })),
  },
  {
    name: "Toppings 表面",
    minRequired: 0,
    maxAllowed: 3,
    modifiers: [
      "Caramel Syrup",
      "Chocolate Syrup",
      "Condensed Milk",
      "Gummy Bears",
      "M&Ms",
      "Mango",
      "Mango Boba",
      "Oreo Cookie",
      "Pineapple",
      "Strawberry",
      "Strawberry Boba",
    ].map((n) => ({ name: n, price: 0 })),
  },
  {
    name: "Boba 啵啵",
    minRequired: 0,
    maxAllowed: 1,
    modifiers: [
      "Apple",
      "Blueberry",
      "Kiwi",
      "Lychee",
      "Mango",
      "Passion Fruit",
      "Peach",
      "Strawberry",
      "Tapioca",
      "Yogurt",
    ].map((n) => ({ name: n, price: 0 })),
  },
  {
    name: "Whipped Cream 奶油",
    minRequired: 0,
    maxAllowed: 1,
    modifiers: [{ name: "Whipped Cream", price: 100 }],
  },
];

// Which items get the Build-a-Roll groups attached.
const CUSTOM_ITEM = "Customize Your Own Roll";

// ── Seed ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding Clover sandbox catalog for merchant ${MID} @ ${BASE}\n`);

  // Categories: find-or-create
  const existingCats = await getAll("/categories");
  const catId = new Map(existingCats.map((c) => [c.name, c.id]));
  for (const name of categories) {
    if (catId.has(name)) {
      reused++;
      continue;
    }
    const c = await api("POST", "/categories", { name });
    catId.set(name, c.id);
    created++;
    console.log(`  + category: ${name}`);
  }

  // Items: find-or-create keyed by name+category, then associate to category
  const existingItems = await getAll("/items?expand=categories");
  const itemKey = (name, cat) => `${name}::${cat}`;
  const itemId = new Map();
  for (const it of existingItems) {
    const cat = it.categories?.elements?.[0]?.name ?? "";
    itemId.set(itemKey(it.name, cat), it.id);
  }

  const catItemLinks = [];
  for (const it of items) {
    const key = itemKey(it.name, it.category);
    if (itemId.has(key)) {
      reused++;
      continue;
    }
    const created_item = await api("POST", "/items", {
      name: it.name,
      price: it.price,
      priceType: "FIXED",
    });
    itemId.set(key, created_item.id);
    catItemLinks.push({ category: { id: catId.get(it.category) }, item: { id: created_item.id } });
    created++;
    console.log(`  + item: ${it.name} ($${(it.price / 100).toFixed(2)}) → ${it.category}`);
  }
  if (catItemLinks.length) {
    await api("POST", "/category_items", { elements: catItemLinks });
    console.log(`  ↳ linked ${catItemLinks.length} item(s) to categories`);
  }

  // Modifier groups + modifiers: find-or-create
  const existingGroups = await getAll("/modifier_groups?expand=modifiers");
  const groupId = new Map(existingGroups.map((g) => [g.name, g.id]));
  const groupMods = new Map(
    existingGroups.map((g) => [g.name, new Set((g.modifiers?.elements ?? []).map((m) => m.name))]),
  );
  for (const grp of modifierGroups) {
    let gid = groupId.get(grp.name);
    if (!gid) {
      const g = await api("POST", "/modifier_groups", {
        name: grp.name,
        showByDefault: false,
        minRequired: grp.minRequired,
        maxAllowed: grp.maxAllowed,
      });
      gid = g.id;
      groupId.set(grp.name, gid);
      groupMods.set(grp.name, new Set());
      created++;
      console.log(`  + modifier group: ${grp.name} (min ${grp.minRequired}, max ${grp.maxAllowed})`);
    } else {
      reused++;
    }
    const haveMods = groupMods.get(grp.name);
    for (const m of grp.modifiers) {
      if (haveMods.has(m.name)) {
        reused++;
        continue;
      }
      await api("POST", `/modifier_groups/${gid}/modifiers`, { name: m.name, price: m.price });
      haveMods.add(m.name);
      created++;
      const tag = m.price ? ` (+$${(m.price / 100).toFixed(2)})` : "";
      console.log(`      · ${grp.name} / ${m.name}${tag}`);
    }
  }

  // Attach Build-a-Roll groups to the Customize item
  const customId = itemId.get(itemKey(CUSTOM_ITEM, ROLLED));
  if (customId) {
    const current = await api(
      "GET",
      `/items/${customId}?expand=modifierGroups`,
    );
    const attached = new Set(
      (current.modifierGroups?.elements ?? []).map((g) => g.id),
    );
    const links = [];
    for (const grp of modifierGroups) {
      const gid = groupId.get(grp.name);
      if (gid && !attached.has(gid)) {
        links.push({ item: { id: customId }, modifierGroup: { id: gid } });
      }
    }
    if (links.length) {
      await api("POST", "/item_modifier_groups", { elements: links });
      console.log(`  ↳ attached ${links.length} modifier group(s) to "${CUSTOM_ITEM}"`);
    }
  }

  // Verify
  console.log(`\nDone. created=${created} reused=${reused}\n`);
  const verify = await api(
    "GET",
    `/items/${customId}?expand=categories,modifierGroups`,
  );
  console.log(
    `Verify "${CUSTOM_ITEM}": category=${verify.categories?.elements?.[0]?.name}, ` +
      `modifierGroups=[${(verify.modifierGroups?.elements ?? []).map((g) => g.name).join(", ")}]`,
  );
  const allItems = await getAll("/items");
  const allCats = await getAll("/categories");
  console.log(`Catalog now: ${allItems.length} items across ${allCats.length} categories.`);
}

main().catch((err) => {
  console.error("\nSEED FAILED:\n" + err.message);
  process.exit(1);
});
