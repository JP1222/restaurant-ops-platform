"use client";

import { useRouter } from "next/navigation";
import { useCart, useCartHydrated } from "@/lib/cartStore";
import { brand } from "@/lib/brand";
import { FLAVOR_COLOR } from "@/lib/menu-adapter";
import { RollCup, Stepper } from "@/components/brand-visuals";

const money = (n: number) => "$" + n.toFixed(2);

export function Cart() {
  const router = useRouter();
  const hydrated = useCartHydrated();
  const lines = useCart((s) => s.lines);
  const subtotal = useCart((s) => s.subtotal());
  const setQuantity = useCart((s) => s.setQuantity);
  const removeLine = useCart((s) => s.removeLine);

  const tax = +(subtotal * brand.taxRate).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  if (!hydrated) return <div className="yr" />;

  const empty = lines.length === 0;

  return (
    <div className="yr">
      <div className="panel-head">
        <button className="iconbtn" type="button" aria-label="Back to menu" onClick={() => router.push("/menu")}>
          ‹
        </button>
        <span className="ttl">Your cart</span>
      </div>

      <div className="yr-scroll">
        <div className="cart-body" style={{ maxWidth: 560, margin: "0 auto", width: "100%" }}>
          {empty ? (
            <div className="empty">
              <div className="ic">🛒</div>
              <h3>Your cart is empty</h3>
              <p>Go build a treat — it only takes a tap.</p>
              <button className="btn btn-ink press" type="button" onClick={() => router.push("/menu")} style={{ marginTop: 14 }}>
                Browse the menu
              </button>
            </div>
          ) : (
            <>
              {lines.map((l) => (
                <div className="cline" key={l.lineId}>
                  <div className="cline-thumb" style={{ background: "var(--pink-soft)" }}>
                    <RollCup flavorColor={(l.flavor && FLAVOR_COLOR[l.flavor]) || "#FBEFD2"} size={48} />
                  </div>
                  <div className="cline-main">
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span className="nm">{l.itemName}</span>
                      <span className="price" style={{ fontSize: 16 }}>
                        {money(l.unitPrice * l.quantity)}
                      </span>
                    </div>
                    <div className="mods">{l.modifiers.length ? l.modifiers.map((m) => m.name).join(", ") : "Standard"}</div>
                    <div className="cline-foot">
                      <Stepper value={l.quantity} min={1} max={20} onChange={(n) => setQuantity(l.lineId, n)} />
                      <button className="linkbtn" type="button" style={{ color: "var(--orange-d)", borderColor: "var(--orange-d)" }} onClick={() => removeLine(l.lineId)}>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              <button className="upsell press" type="button" onClick={() => router.push("/menu")} style={{ width: "100%", boxShadow: "none" }}>
                <span style={{ fontSize: 22 }}>🧋</span>
                <span className="nm">Add a drink to go with it?</span>
                <span className="chip">Browse</span>
              </button>

              <div className="summary" style={{ marginTop: 4 }}>
                <div className="srow">
                  <span className="k">Subtotal</span>
                  <span className="v">{money(subtotal)}</span>
                </div>
                <div className="srow">
                  <span className="k">Tax (est.)</span>
                  <span className="v">{money(tax)}</span>
                </div>
                <div className="srow tot">
                  <span className="k">Total</span>
                  <span className="v">{money(total)}</span>
                </div>
              </div>
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", textAlign: "center", marginTop: 10 }}>
                Final tax is calculated at checkout · pickup at {brand.location}.
              </p>
            </>
          )}
        </div>
      </div>

      {!empty && (
        <div className="panel-foot">
          <button className="btn btn-lg btn-block press" type="button" style={{ width: "100%", maxWidth: 560, margin: "0 auto" }} onClick={() => router.push("/checkout")}>
            Checkout · {money(total)}
          </button>
        </div>
      )}
    </div>
  );
}
