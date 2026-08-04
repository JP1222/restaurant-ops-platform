/**
 * POS-neutral ordering client. The UI talks only to this `api` object; it never
 * knows whether the POS underneath is Clover, Square, or Toast, nor that the
 * wire contract is integer cents — this layer + the same-origin BFF route
 * handlers (app/api/order/*) translate to the dollar `Money` shape in
 * lib/types.ts.
 *
 * All methods now hit the real backend through the BFF (ADR-0027 ·
 * docs/design/online-ordering/handoff.md):
 *   getMenu ............ merchant's live Clover catalog (dev-only MOCK fallback).
 *   getQueueEstimate ... labeled `fallback` until a real estimate endpoint lands.
 *   createOrder ........ prices a Redis draft (server-authoritative totals).
 *   checkout ........... charges the hosted-iframe token → paid Clover order → KDS.
 *   getOrderStatus ..... polls the order lifecycle (Received → Preparing → Ready).
 *
 * Card data never touches this layer: the browser tokenizes the card directly
 * in Clover's hosted iframe (lib/clover-sdk.ts) and only the opaque `clv_…`
 * token reaches `checkout()`.
 */
import type {
  Menu,
  OrderCheckoutRequest,
  OrderConfirmation,
  OrderRequest,
  OrderResponse,
  OrderStatus,
  QueueEstimate,
} from "./types";
import { MOCK_MENU } from "./mock-menu";

const isDev = process.env.NODE_ENV !== "production";

// Same-origin GET against a BFF route handler. The handlers own the kds-api
// host + the cents→dollars conversion, so callers here stay in dollar shapes.
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(await errorMessage(res, path));
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, path));
  }
  return (await res.json()) as T;
}

// Prefer the BFF's `{ error }` text (a customer-safe message it forwards from
// kds-api, e.g. "Your card was declined.") so the Checkout screen can show it
// verbatim; fall back to the status code.
async function errorMessage(res: Response, path: string): Promise<string> {
  const detail = (await res.json().catch(() => null)) as { error?: string } | null;
  return detail && typeof detail.error === "string" ? detail.error : `${path} → ${res.status}`;
}

export const api = {
  async getMenu(): Promise<Menu> {
    try {
      return await getJson<Menu>("/api/order/menu");
    } catch (err) {
      // Dev convenience: with no kds-api running locally the prototype still
      // renders off the bundled mock. Dead-code-eliminated in production builds
      // (`isDev` folds to false), where an unreachable menu must surface as an
      // error rather than silently serving fake prices.
      if (isDev) {
        console.warn("[order-web] getMenu fell back to MOCK_MENU:", err);
        return MOCK_MENU;
      }
      throw err;
    }
  },

  async getQueueEstimate(): Promise<QueueEstimate> {
    return getJson<QueueEstimate>("/api/order/queue");
  },

  /** Price a draft. Returns the server-authoritative totals; no money moves. */
  async createOrder(body: OrderRequest): Promise<OrderResponse> {
    return postJson<OrderResponse>("/api/order", body);
  },

  /** Charge a draft with the hosted-iframe token. THE money step. */
  async checkout(req: OrderCheckoutRequest): Promise<OrderConfirmation> {
    return postJson<OrderConfirmation>("/api/order/checkout", req);
  },

  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    return getJson<OrderStatus>(`/api/order/${encodeURIComponent(orderId)}/status`);
  },
};
