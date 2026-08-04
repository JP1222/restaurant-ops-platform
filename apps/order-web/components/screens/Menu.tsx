"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCart, useCartHydrated } from "@/lib/cartStore";
import { useIsDesktop } from "@/lib/hooks";
import type { Menu as MenuData, MenuItem } from "@/lib/types";
import { badgeFromTags, itemCupColor, itemKind, tintForIndex } from "@/lib/menu-adapter";
import { storeStatus, type StoreStatus } from "@/lib/hours";
import { BobaCup, RollCup, Wordmark } from "@/components/brand-visuals";
import { ItemBuilder } from "@/components/ItemBuilder";

const money = (n: number) => "$" + n.toFixed(2);
const secId = (cat: string) => "sec-" + cat.replace(/\s+/g, "-").toLowerCase();

export function Menu() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const hydrated = useCartHydrated();
  const lines = useCart((s) => s.lines);
  const subtotal = useCart((s) => s.subtotal());
  const count = useCart((s) => s.totalQuantity());

  const [menu, setMenu] = useState<MenuData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState<MenuItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState<string>("");
  const [store, setStore] = useState<StoreStatus | null>(null);

  // Open/closed status is time-dependent, so compute it on the client only
  // (SSR has no stable "now") and refresh each minute to roll over the label.
  useEffect(() => {
    const update = () => setStore(storeStatus(new Date()));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .getMenu()
      .then((m) => {
        if (!alive) return;
        setMenu(m);
        setActiveCat(m.categories[0] ?? "");
      })
      .catch((e) => alive && setError((e as Error).message || "Menu is unavailable right now."));
    return () => {
      alive = false;
    };
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1600);
  };
  const onAdded = () => showToast("Added to cart 🎉");

  const jumpTo = (cat: string) => {
    setActiveCat(cat);
    document.getElementById(secId(cat))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const sections = useMemo(() => {
    if (!menu) return [];
    let idx = 0;
    return menu.categories
      .map((cat) => ({
        cat,
        items: menu.items.filter((i) => i.category === cat).map((it) => ({ it, tintIdx: idx++ })),
      }))
      .filter((s) => s.items.length > 0);
  }, [menu]);

  const catTabs = menu?.categories.map((cat) => (
    <button key={cat} type="button" className={"cattab" + (activeCat === cat ? " on" : "")} onClick={() => jumpTo(cat)}>
      {cat}
    </button>
  ));

  const loyChip = (
    <span className="loychip">
      <span className="dot" /> Join &amp; earn
    </span>
  );

  const sectionsView = (
    <>
      {error && (
        <div className="empty">
          <div className="ic">🍦</div>
          <h3>Menu unavailable</h3>
          <p>{error}</p>
          <button className="btn btn-ink" type="button" onClick={() => location.reload()} style={{ marginTop: 12 }}>
            Try again
          </button>
        </div>
      )}
      {!menu && !error && <MenuSkeleton />}
      {sections.map(({ cat, items }) => (
        <section key={cat} className="menu-sec" id={secId(cat)}>
          <h3 className="sec-h">{cat}</h3>
          <div className="menu-grid">
            {items.map(({ it, tintIdx }) => (
              <MenuCard key={it.id} item={it} tintIdx={tintIdx} onOpen={() => it.available !== false && setBuilding(it)} />
            ))}
          </div>
        </section>
      ))}
    </>
  );

  return (
    <div className={"yr " + (isDesktop ? "d" : "m")}>
      {isDesktop ? (
        <>
          <div className="desk-nav">
            <Wordmark size={30} />
            <div className="navlinks">{catTabs}</div>
            {loyChip}
          </div>
          <div className="desk-main">
            <div className="desk-menu yr-scroll">{sectionsView}</div>
            <aside className="desk-cart">
              <div className="desk-cart-head">
                <h3>Your cart</h3>
                <span className="eyebrow">
                  {count} item{count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="desk-cart-body">
                {hydrated && lines.length > 0 ? (
                  lines.map((l) => (
                    <div className="cline" key={l.lineId} style={{ marginBottom: 10 }}>
                      <div className="cline-main">
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <span className="nm">
                            {l.quantity}× {l.itemName}
                          </span>
                          <span className="price" style={{ fontSize: 15 }}>
                            {money(l.unitPrice * l.quantity)}
                          </span>
                        </div>
                        {l.modifiers.length > 0 && <div className="mods">{l.modifiers.map((m) => m.name).join(", ")}</div>}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty" style={{ padding: "40px 20px" }}>
                    <div className="ic">🛒</div>
                    <h3>Empty cart</h3>
                    <p>Pick a treat to get rolling.</p>
                  </div>
                )}
              </div>
              <div className="desk-cart-foot">
                <div className="srow" style={{ fontFamily: "var(--font-disp)", fontSize: 20 }}>
                  <span className="k">Subtotal</span>
                  <span className="v" style={{ color: "var(--pink)" }}>
                    {money(subtotal)}
                  </span>
                </div>
                <button
                  className="btn btn-lg btn-block press"
                  type="button"
                  disabled={!lines.length}
                  onClick={() => router.push("/cart")}
                  style={{ marginTop: 12, width: "100%" }}
                >
                  Review &amp; checkout
                </button>
              </div>
            </aside>
          </div>
        </>
      ) : (
        <>
          <header className="appbar">
            <div className="appbar-top">
              <Wordmark size={26} />
              {loyChip}
            </div>
            <div className="appbar-controls">
              <div className="miniseg">
                <button className="on" type="button">
                  🛍 Pickup
                </button>
                <button disabled type="button">
                  🚗 Delivery
                </button>
              </div>
              <div className="miniseg">
                <button className="on" type="button">
                  Now
                </button>
                <button data-k="later" type="button">
                  Later
                </button>
              </div>
              <span className={store?.open === false ? "storestat closed" : "storestat"}>
                <span className="live" /> {store?.label ?? " "}
              </span>
            </div>
          </header>
          <nav className="cattabs">{catTabs}</nav>
          <div className="yr-scroll">
            <div className="menu-body">{sectionsView}</div>
          </div>
          {hydrated && count > 0 && (
            <div className="cartbar">
              <button className="cartbar-inner press" type="button" onClick={() => router.push("/cart")}>
                <span className="cnt">{count}</span>
                <span className="lbl">View cart</span>
                <span className="tot">{money(subtotal)}</span>
              </button>
            </div>
          )}
        </>
      )}

      {building && (
        <>
          <div className="scrim" onClick={() => setBuilding(null)} />
          <ItemBuilder item={building} desktop={isDesktop} onClose={() => setBuilding(null)} onAdded={onAdded} />
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function MenuCard({ item, tintIdx, onOpen }: { item: MenuItem; tintIdx: number; onOpen: () => void }) {
  const kind = itemKind(item.category);
  const sold = item.available === false;
  const badge = badgeFromTags(item.tags);

  if (kind !== "rolled") {
    return (
      <button className="drink-card press" disabled={sold} type="button" onClick={onOpen} style={{ width: "100%" }}>
        <BobaCup color={itemCupColor(item)} pearls={1} smoothie={kind === "smoothie"} size={52} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <span className="nm">{item.name}</span>
            <span className="price">{money(item.price)}</span>
          </div>
          {item.description && <div className="ds">{item.description}</div>}
        </div>
      </button>
    );
  }

  return (
    <div
      className={"icard" + (sold ? " sold" : "")}
      role="button"
      tabIndex={0}
      onClick={() => !sold && onOpen()}
      onKeyDown={(e) => e.key === "Enter" && !sold && onOpen()}
    >
      <div className={"icard-photo " + tintForIndex(tintIdx)}>
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt={item.name} loading="lazy" />
        ) : (
          <RollCup flavorColor={itemCupColor(item)} size={92} />
        )}
        {badge && <span className={"badge " + badge.c}>{badge.t}</span>}
      </div>
      <div className="icard-meta">
        <div className="nm">{item.name}</div>
        {item.description && <div className="ds">{item.description}</div>}
        <div className="icard-foot">
          <div className="price">{money(item.price)}</div>
          {!sold && (
            <button
              className="add-pill"
              type="button"
              aria-label={"Add " + item.name}
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              +
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuSkeleton() {
  return (
    <div style={{ marginTop: 18 }}>
      <div className="sk" style={{ width: 180, height: 26, marginBottom: 14 }} />
      <div className="menu-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card" style={{ overflow: "hidden", boxShadow: "none" }}>
            <div className="sk" style={{ aspectRatio: "1 / 1", borderRadius: 0 }} />
            <div style={{ padding: 13 }}>
              <div className="sk" style={{ height: 16, width: "70%", marginBottom: 8 }} />
              <div className="sk" style={{ height: 12, width: "90%" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
