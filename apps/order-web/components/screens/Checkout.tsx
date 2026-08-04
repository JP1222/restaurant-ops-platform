"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCart, useCartHydrated } from "@/lib/cartStore";
import { brand } from "@/lib/brand";
import { useIsDesktop } from "@/lib/hooks";
import {
  CARD_FIELD_IDS,
  mountCloverCard,
  readCloverConfig,
  type MountedCloverCard,
} from "@/lib/clover-sdk";
import type { OrderResponse } from "@/lib/types";

const money = (n: number) => "$" + n.toFixed(2);

const TIPS = [
  { id: "none", label: "No tip", pct: 0 },
  { id: "15", label: "15%", pct: 0.15 },
  { id: "18", label: "18%", pct: 0.18 },
  { id: "20", label: "20%", pct: 0.2 },
];

/**
 * Checkout — single-scroll Berry design over the REAL two-call payment flow:
 *   createOrder() prices an authoritative draft → Clover hosted-iframe tokenizes
 *   the card (PAN never touches us, SAQ-A) → checkout() charges the draft (+tip)
 *   → /confirmation/{orderId}. Wallets / loyalty / gift cards are designed but
 *   intentionally omitted here (not backend-wired — Phase 2/3).
 */
export function Checkout() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const hydrated = useCartHydrated();
  const lines = useCart((s) => s.lines);
  const subtotal = useCart((s) => s.subtotal());

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [tipId, setTipId] = useState("none");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [giftOpen, setGiftOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const paymentConfig = useMemo(() => readCloverConfig(), []);
  const cardRef = useRef<MountedCloverCard | null>(null);
  const mountStartedRef = useRef(false);
  const submittingRef = useRef(false);
  const [cardReady, setCardReady] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  // Bounce on an empty cart, but only after rehydration.
  useEffect(() => {
    if (hydrated && lines.length === 0) router.replace("/menu");
  }, [hydrated, lines.length, router]);

  // Mount Clover's card iframes once (single page → the mount divs exist on load).
  useEffect(() => {
    if (!paymentConfig || mountStartedRef.current) return;
    mountStartedRef.current = true;
    mountCloverCard(paymentConfig)
      .then((card) => {
        cardRef.current = card;
        setCardReady(true);
      })
      .catch((err) => setCardError((err as Error).message || "Could not load the payment form."));
  }, [paymentConfig]);

  const tip = useMemo(() => +((subtotal * (TIPS.find((t) => t.id === tipId)?.pct ?? 0)).toFixed(2)), [subtotal, tipId]);
  const taxEstimate = useMemo(() => +(subtotal * brand.taxRate).toFixed(2), [subtotal]);
  const totalEstimate = useMemo(() => +(subtotal + taxEstimate + tip).toFixed(2), [subtotal, taxEstimate, tip]);

  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const nameOk = name.trim().length > 1;
  const canPay = nameOk && phoneOk && Boolean(paymentConfig) && cardReady && !submitting;

  const place = async () => {
    setTouched(true);
    setError(null);
    if (!nameOk || !phoneOk) return;
    if (!cardRef.current || !cardReady) {
      setError("The payment form is still loading — one moment.");
      return;
    }
    // Synchronous double-submit guard. setSubmitting is async, so a fast
    // double-tap (realistic on mobile) can re-enter place() before the button
    // re-renders disabled — firing createOrder twice creates two drafts and two
    // charges (idempotency is keyed per-draft, so they are NOT deduped). The
    // ref flips synchronously, so the second tap bails here.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const draft: OrderResponse = await api.createOrder({
        customerName: name.trim(),
        customerPhone: phone.trim() || undefined,
        customerEmail: email.trim() || undefined,
        notes: notes.trim() || undefined,
        lines,
      });
      const tokenResult = await cardRef.current.createToken();
      if ("error" in tokenResult) {
        setError(tokenResult.error);
        setSubmitting(false);
        return;
      }
      const confirmation = await api.checkout({
        orderId: draft.orderId,
        paymentToken: tokenResult.token,
        tip: tip || undefined,
      });
      router.push(`/confirmation/${confirmation.orderId}`);
    } catch (err) {
      setError((err as Error).message || "Payment could not be completed.");
      setSubmitting(false);
    } finally {
      // Release the guard on every exit — token error, charge failure, or
      // success after router.push has fired. setSubmitting stays true on the
      // success path on purpose: the button stays disabled during navigation.
      submittingRef.current = false;
    }
  };

  if (!hydrated || lines.length === 0) return <div className="yr" />;

  const summary = (
    <div className="summary">
      <div className="srow">
        <span className="k">Subtotal</span>
        <span className="v">{money(subtotal)}</span>
      </div>
      <div className="srow">
        <span className="k">Tax (est.)</span>
        <span className="v">{money(taxEstimate)}</span>
      </div>
      {tip > 0 && (
        <div className="srow">
          <span className="k">Tip</span>
          <span className="v">{money(tip)}</span>
        </div>
      )}
      <div className="srow tot">
        <span className="k">Total</span>
        <span className="v">{money(totalEstimate)}</span>
      </div>
    </div>
  );

  const placeBtn = (
    <button className="btn btn-lg btn-block press" type="button" disabled={!canPay} onClick={place} style={{ width: "100%" }}>
      {submitting ? "Processing payment…" : canPay ? `Place order · ${money(totalEstimate)}` : nameOk && phoneOk ? "Loading secure payment…" : "Add your name & phone"}
    </button>
  );

  const body = (
    <>
      <div className="co-sec">
        <h4>Pickup</h4>
        <div className="card" style={{ padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 24 }}>🏬</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800 }}>{brand.location}</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Ready ASAP · pickup only</div>
          </div>
        </div>
      </div>

      <div className="co-sec">
        <h4>Your info</h4>
        <div className="field">
          <label>
            Name <span className="req">*</span>
          </label>
          <input className="input" placeholder="First name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" name="pickup-name" />
        </div>
        <div className={"field" + (touched && !phoneOk ? " err" : "")}>
          <label>
            Mobile <span className="req">*</span> <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>· for “order ready” text</span>
          </label>
          <input className="input" placeholder="(901) 555-0148" inputMode="tel" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          {touched && !phoneOk && (
            <div className="errmsg" role="alert">
              ⚠ Enter a valid mobile number
            </div>
          )}
        </div>
        <div className="field">
          <label>
            Email <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>· optional, for receipt</span>
          </label>
          <input className="input" placeholder="you@email.com" inputMode="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>

      <div className="co-sec">
        <h4>Tip your roller</h4>
        <div className="tips">
          {TIPS.map((t) => (
            <button key={t.id} type="button" className={"tip" + (tipId === t.id ? " on" : "")} onClick={() => setTipId(t.id)}>
              {t.label}
              {t.pct ? <span className="sub">{money(subtotal * t.pct)}</span> : <span className="sub">—</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="co-sec">
        <h4>Payment</h4>
        {paymentConfig ? (
          <div className="clover-field">
            <span className="clover-tag">Secured by Clover</span>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Card number</label>
              <CardSlot id={CARD_FIELD_IDS.number} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Expiry</label>
                <CardSlot id={CARD_FIELD_IDS.date} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>CVV</label>
                <CardSlot id={CARD_FIELD_IDS.cvv} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>ZIP</label>
                <CardSlot id={CARD_FIELD_IDS.postal} />
              </div>
            </div>
            {!cardReady && !cardError && <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>Loading secure card form…</div>}
            {cardError && (
              <div className="errmsg" role="alert" style={{ marginTop: 8 }}>
                ⚠ {cardError}
              </div>
            )}
          </div>
        ) : (
          <div className="clover-field" style={{ borderStyle: "dashed" }}>
            Card payment isn’t configured in this environment yet. Your order is priced and ready — payment turns on once the Clover key is set.
          </div>
        )}
      </div>

      <button className={"collapse-head collapse press" + (giftOpen ? " open" : "")} type="button" onClick={() => setGiftOpen((o) => !o)} style={{ marginBottom: 12 }}>
        <span className="ic">🎁</span> Apply a gift card <span className="chev">⌄</span>
      </button>
      {giftOpen && (
        <div className="card" style={{ padding: 14, marginTop: -6, marginBottom: 12, boxShadow: "none" }}>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Gift cards are coming soon — you’ll be able to apply a balance and split tender here.</div>
        </div>
      )}

      <button className={"collapse-head collapse press" + (notesOpen ? " open" : "")} type="button" onClick={() => setNotesOpen((o) => !o)} style={{ marginBottom: 12 }}>
        <span className="ic">📝</span> Order notes <span className="chev">⌄</span>
      </button>
      {notesOpen && (
        <div className="card" style={{ padding: 14, marginTop: -6, marginBottom: 12, boxShadow: "none" }}>
          <input className="input" placeholder="Allergies or special requests?" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      )}

      {error && (
        <div className="errmsg" role="alert" style={{ marginBottom: 12 }}>
          ⚠ {error}
        </div>
      )}
    </>
  );

  if (isDesktop) {
    return (
      <div className={"yr d"}>
        <div className="panel-head">
          <button className="iconbtn" type="button" aria-label="Back to cart" onClick={() => router.push("/cart")}>
            ‹
          </button>
          <span className="ttl">Checkout</span>
        </div>
        <div className="co-wrap yr-scroll">
          <div className="co-inner">
            <div>{body}</div>
            <aside className="co-aside">
              {summary}
              <div style={{ marginTop: 14 }}>{placeBtn}</div>
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", textAlign: "center", marginTop: 10 }}>Real prices, no hidden fees.</p>
            </aside>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="yr m">
      <div className="panel-head">
        <button className="iconbtn" type="button" aria-label="Back to cart" onClick={() => router.push("/cart")}>
          ‹
        </button>
        <span className="ttl">Checkout</span>
      </div>
      <div className="yr-scroll">
        <div className="co-body">
          {body}
          {summary}
        </div>
      </div>
      <div className="panel-foot">{placeBtn}</div>
    </div>
  );
}

/** Clover injects a hosted card-field iframe into this mount point. */
function CardSlot({ id }: { id: string }) {
  return <div id={id} className="input" style={{ height: 48, padding: "0 10px", display: "flex", alignItems: "center" }} />;
}
