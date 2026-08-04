import client from "prom-client";

// GH #469: tryListV1Refunds() returns [] on a fetch failure so the dimension
// sweep can still proceed — but that makes "refund fetch failed" indistinguish-
// able from "no refunds", silently under-counting refunds (which OVERSTATES net
// sales) with no signal. The internal raw-vs-mart reconciliation can't catch it
// either: a missing-from-raw refund leaves both raw and mart equally empty, so
// the delta is 0 and recon PASSES. This counter is the only observable signal
// that the swallow happened — alert on its rate.
//
// Registered on prom-client's DEFAULT registry (the same `client.register`
// served at GET /metrics) so it surfaces with no extra route. Labelled by
// merchant_id because the sweep runs per sync target (ADR-0018 multi-location).
// The getSingleMetric guard mirrors backfill-gauges.ts — prom-client throws on
// duplicate registration under `tsx watch` reloads and repeated imports.
const register = client.register;

export const cloverV1RefundFetchFailuresTotal: client.Counter<"merchant_id"> =
  (register.getSingleMetric("rop_clover_v1_refund_fetch_failures_total") as
    | client.Counter<"merchant_id">
    | undefined) ??
  new client.Counter({
    name: "rop_clover_v1_refund_fetch_failures_total",
    help: "Clover v1 /refunds pulls that failed and were swallowed to an empty result (refund undercount risk).",
    labelNames: ["merchant_id"],
    registers: [register],
  });
