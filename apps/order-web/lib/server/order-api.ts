/**
 * Server-side base URL for the public ordering API (kds-api `/api/order/*`).
 *
 * Never exposed to the browser: the browser only ever calls same-origin
 * `/api/order/*` BFF route handlers (app/api/order/*), which forward here.
 * Mirrors crew-web's `lib/server/inventory-api.ts` pattern — minus the session
 * cookie. The ordering routes are a PUBLIC route group (no auth preHandler in
 * kds-api), so there is no secret or session to forward; the only request-bound
 * value the BFF must carry downstream is the customer's IP, and only on the
 * checkout charge (added in PR5b).
 */
export function orderApiUrl(path: string): string {
  const base = process.env.ORDER_API_BASE_URL ?? "http://localhost:4000";
  return `${base}${path}`;
}
