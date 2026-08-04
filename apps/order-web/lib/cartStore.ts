"use client";

/**
 * Cart state — Zustand with localStorage persistence so a customer can scroll
 * the menu, navigate around, and not lose their order. Consumed only by client
 * components; `persist` guards localStorage access so SSR is safe.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CartLine, MenuItem, Modifier } from "./types";
import { inferFlavor } from "./flavors";

interface CartState {
  lines: CartLine[];
  addItem: (item: MenuItem, selectedModifiers: Modifier[], notes?: string) => void;
  removeLine: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  clear: () => void;
  subtotal: () => number;
  totalQuantity: () => number;
}

const newLineId = () =>
  // Stable enough for cart line dedupe; not crypto-strength.
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],

      addItem: (item, selectedModifiers, notes) => {
        const unitPrice =
          item.price + selectedModifiers.reduce((sum, m) => sum + m.priceDelta, 0);
        const line: CartLine = {
          lineId: newLineId(),
          itemId: item.id,
          itemName: item.name,
          unitPrice,
          quantity: 1,
          modifiers: selectedModifiers.map((m) => ({
            id: m.id,
            name: m.name,
            priceDelta: m.priceDelta,
          })),
          notes,
          flavor: item.flavor ?? inferFlavor(item.name),
          imageUrl: item.imageUrl,
        };
        set({ lines: [...get().lines, line] });
      },

      removeLine: (lineId) =>
        set({ lines: get().lines.filter((l) => l.lineId !== lineId) }),

      setQuantity: (lineId, quantity) =>
        set({
          lines:
            quantity <= 0
              ? get().lines.filter((l) => l.lineId !== lineId)
              : get().lines.map((l) =>
                  l.lineId === lineId
                    ? { ...l, quantity: Math.min(20, quantity) }
                    : l,
                ),
        }),

      clear: () => set({ lines: [] }),

      subtotal: () =>
        get().lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),

      totalQuantity: () => get().lines.reduce((sum, l) => sum + l.quantity, 0),
    }),
    { name: "rop-cart" },
  ),
);

// Stable no-op subscribe — the server/client distinction never changes after
// the first client commit, so there is nothing to subscribe to.
const noopSubscribe = () => () => {};

/**
 * SSR-safe "is the client-side cart available yet" flag: false during server
 * render and the first hydration pass, true thereafter. Guards that redirect
 * on an empty cart (e.g. Checkout) wait for this so a full page load doesn't
 * bounce a customer before zustand's localStorage-backed cart is read
 * (refresh, deep link, or the Hosted Checkout redirect back). Uses
 * useSyncExternalStore so there's no setState-in-effect and no access to the
 * persist API during SSR (it isn't initialised on the server).
 */
export function useCartHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
