"use client";

import { useMemo, useRef, useState } from "react";
import type { MenuItem, ModifierGroup } from "@/lib/types";
import { useCart } from "@/lib/cartStore";
import {
  type GroupControl,
  flavorColorFromName,
  groupControl,
  isFlavorGroup,
  isToppingGroup,
  itemCupColor,
  itemKind,
  selectedModifiers,
  toppingColorFromName,
} from "@/lib/menu-adapter";
import { BobaCup, RollCup, type ToppingDot, Stepper } from "@/components/brand-visuals";

const money = (n: number) => "$" + n.toFixed(2);
type Sel = Record<string, string | string[]>;

function defaultSel(item: MenuItem): Sel {
  const sel: Sel = {};
  for (const g of item.modifierGroups) {
    sel[g.id] = groupControl(g).kind === "single" ? "" : [];
  }
  return sel;
}

function unitPrice(item: MenuItem, sel: Sel): number {
  let p = item.price;
  for (const g of item.modifierGroups) {
    const v = sel[g.id];
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    for (const id of ids) {
      const m = g.modifiers.find((mm) => mm.id === id);
      if (m) p += m.priceDelta;
    }
  }
  return p;
}

function groupSatisfied(g: ModifierGroup, sel: Sel): boolean {
  const c = groupControl(g);
  if (!c.required) return true;
  const v = sel[g.id];
  return c.kind === "single" ? !!v : Array.isArray(v) && v.length >= g.minSelections;
}

function isValid(item: MenuItem, sel: Sel): boolean {
  return item.modifierGroups.every((g) => groupSatisfied(g, sel));
}

/** Preview color + scattered topping dots from the current selection. */
function previewProps(item: MenuItem, sel: Sel) {
  let flavorColor = itemCupColor(item);
  const dots: ToppingDot[] = [];
  const drizzle: string[] = [];
  for (const g of item.modifierGroups) {
    const v = sel[g.id];
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    if (isFlavorGroup(g) && ids[0]) {
      const m = g.modifiers.find((mm) => mm.id === ids[0]);
      if (m) flavorColor = flavorColorFromName(m.name);
    } else if (isToppingGroup(g)) {
      for (const id of ids) {
        const m = g.modifiers.find((mm) => mm.id === id);
        if (!m) continue;
        if (/drizzle|sauce/i.test(g.name)) drizzle.push(toppingColorFromName(m.name));
        else dots.push({ key: g.id + id, color: toppingColorFromName(m.name) });
      }
    }
  }
  return { flavorColor, dots: dots.slice(0, 12), drizzle };
}

function Preview({ item, sel, size }: { item: MenuItem; sel: Sel; size: number }) {
  const kind = itemKind(item.category);
  if (kind === "rolled") {
    const pp = previewProps(item, sel);
    return <RollCup {...pp} size={size} />;
  }
  const pp = previewProps(item, sel);
  const pearls = item.modifierGroups.reduce((n, g) => {
    if (!isToppingGroup(g)) return n;
    const v = sel[g.id];
    return n + (Array.isArray(v) ? v.length : 0);
  }, 0);
  return <BobaCup color={pp.flavorColor} pearls={pearls} smoothie={kind === "smoothie"} size={size * 0.82} />;
}

function GroupBlock({
  group,
  control,
  sel,
  setSel,
}: {
  group: ModifierGroup;
  control: GroupControl;
  sel: Sel;
  setSel: (gid: string, val: string | string[]) => void;
}) {
  const v = sel[group.id];
  const satisfied = groupSatisfied(group, sel);
  const selectedCount = Array.isArray(v) ? v.length : 0;

  const toggleMulti = (id: string) => {
    const cur = Array.isArray(v) ? v : [];
    if (cur.includes(id)) setSel(group.id, cur.filter((x) => x !== id));
    else if (!control.max || cur.length < control.max) setSel(group.id, [...cur, id]);
  };

  return (
    <div className="mgroup" data-group={group.id}>
      <div className="mgroup-head">
        <h4>{group.name}</h4>
        <span className={"rule " + (control.required ? (satisfied ? "ok" : "req") : "opt")}>
          {control.required && satisfied ? "✓ Set" : control.rule}
          {control.kind === "multi" && control.max ? ` · ${selectedCount}/${control.max}` : ""}
        </span>
      </div>

      {control.kind === "single" && control.layout === "swatch" && (
        <div className="opts">
          {group.modifiers.map((o) => {
            const on = v === o.id;
            return (
              <button key={o.id} type="button" className={"opt" + (on ? " sel" : "")} onClick={() => setSel(group.id, o.id)} aria-pressed={on}>
                <span className="swatch" style={{ background: flavorColorFromName(o.name) }} />
                <span className="nm">{o.name}</span>
                {o.priceDelta ? <span className="pr">+{money(o.priceDelta)}</span> : null}
                <span className="mark">{on ? "✓" : ""}</span>
              </button>
            );
          })}
        </div>
      )}

      {control.kind === "single" && control.layout === "pill" && (
        <div className="opt-grid" style={{ gridTemplateColumns: group.modifiers.length > 3 ? "repeat(auto-fit,minmax(86px,1fr))" : `repeat(${group.modifiers.length},1fr)` }}>
          {group.modifiers.map((o) => {
            const on = v === o.id;
            return (
              <button key={o.id} type="button" className={"opt pill" + (on ? " sel" : "")} onClick={() => setSel(group.id, o.id)} aria-pressed={on}>
                <span className="nm">{o.name}</span>
                {o.priceDelta ? <span className="pr">+{money(o.priceDelta)}</span> : null}
              </button>
            );
          })}
        </div>
      )}

      {control.kind === "multi" && (
        <div className="opts">
          {group.modifiers.map((o) => {
            const on = Array.isArray(v) && v.includes(o.id);
            const blocked = !on && control.max > 0 && selectedCount >= control.max;
            return (
              <button
                key={o.id}
                type="button"
                className={"opt square" + (on ? " sel" : "")}
                onClick={() => toggleMulti(o.id)}
                aria-pressed={on}
                style={blocked ? { opacity: 0.45 } : undefined}
              >
                <span className="mark">{on ? "✓" : ""}</span>
                <span className="nm">{o.name}</span>
                {o.priceDelta ? <span className="pr">+{money(o.priceDelta)}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ItemBuilder({
  item,
  desktop = false,
  onClose,
  onAdded,
}: {
  item: MenuItem;
  desktop?: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const addItem = useCart((s) => s.addItem);
  const [sel, setSelState] = useState<Sel>(() => defaultSel(item));
  const [qty, setQty] = useState(1);
  const [flashId, setFlashId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const setSel = (gid: string, val: string | string[]) => setSelState((s) => ({ ...s, [gid]: val }));

  const valid = useMemo(() => isValid(item, sel), [item, sel]);
  const price = unitPrice(item, sel) * qty;

  const tryAdd = () => {
    if (!valid) {
      const unmet = item.modifierGroups.find((g) => !groupSatisfied(g, sel));
      if (unmet && bodyRef.current) {
        bodyRef.current.querySelector(`[data-group="${unmet.id}"]`)?.scrollIntoView({ block: "center" });
        setFlashId(unmet.id);
        setTimeout(() => setFlashId(null), 600);
      }
      return;
    }
    // addItem appends one line at qty 1; bump it to the chosen qty via the
    // store's own setQuantity (keeps it a single grouped cart line).
    const mods = selectedModifiers(item, sel);
    addItem(item, mods);
    if (qty > 1) {
      const st = useCart.getState();
      const last = st.lines[st.lines.length - 1];
      if (last) st.setQuantity(last.lineId, qty);
    }
    onAdded();
    onClose();
  };

  return (
    <div className={"panel" + (desktop ? " modal" : "")} role="dialog" aria-label={`Customize ${item.name}`} onClick={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <button className="iconbtn" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
        <span className="ttl">Build · {item.name}</span>
      </div>

      <div className="bld-hero">
        <div className="preview-wrap">
          <Preview item={item} sel={sel} size={desktop ? 128 : 118} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bld-name">{item.name}</div>
          {item.description ? <div className="bld-desc">{item.description}</div> : null}
          <div className="bld-cal">base {money(item.price)}</div>
        </div>
      </div>

      <div className="panel-body" ref={bodyRef}>
        {item.modifierGroups.length === 0 ? (
          <div style={{ padding: "22px 16px", color: "var(--ink-2)", fontSize: 14 }}>No choices to make — just add it to your cart. 🍦</div>
        ) : (
          item.modifierGroups.map((g) => (
            <div key={g.id} className={flashId === g.id ? "req-flash" : ""}>
              <GroupBlock group={g} control={groupControl(g)} sel={sel} setSel={setSel} />
            </div>
          ))
        )}
        <div style={{ height: 8 }} />
      </div>

      <div className="panel-foot">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Stepper value={qty} onChange={setQty} min={1} max={9} />
          <button className="btn btn-lg btn-block" disabled={!valid} onClick={tryAdd} type="button" style={{ flex: 1 }}>
            {valid ? `Add to cart · ${money(price)}` : "Pick a flavor to continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
