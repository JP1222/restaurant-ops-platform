import type { FastifyBaseLogger } from "fastify";
import { buildOrderCart } from "../domain/build-order-cart.js";
import type { OrderDraft } from "./order-draft.js";
import type { AppServices } from "./services.js";

export type CheckoutErrorCode = "payment_failed" | "order_failed" | "not_configured";

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;

  constructor(code: CheckoutErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CheckoutError";
    this.code = code;
  }
}

export interface MerchantOrderConfig {
  // Taxable order type to reference (null → no tax / bare merchant).
  orderTypeId: string | null;
  // External Payment tender id used to settle the order.
  tenderId: string;
}

export interface CheckoutInput {
  merchantId: string;
  draft: OrderDraft;
  config: MerchantOrderConfig;
  paymentToken: string;
  tipCents: number;
  clientIp: string;
  idempotencyKey: string;
  log: FastifyBaseLogger;
}

export interface CheckoutResult {
  cloverOrderId: string;
  chargeId: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The money path. Verified sequence (Clover sandbox 2026-05-31):
 *   charge (clv_ token) → createAtomicOrder → attach customer+phone →
 *   recordOrderPayment (External Payment tender) → order paymentState becomes
 *   PAID (async, ~seconds) → the O: webhook → the existing sync → the KDS.
 *
 * Compensation: once the charge succeeds, ANY later failure refunds the charge,
 * so a customer is never charged for an order that never reaches the kitchen. A
 * refund that itself fails is logged loudly for manual reconciliation — the one
 * state we cannot auto-heal.
 */
export async function checkoutOrder(
  services: AppServices,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const { merchantId, draft, config, log } = input;

  if (!services.cloverEcommerce.configured) {
    throw new CheckoutError("not_configured", "Online payments are not configured.");
  }

  // 1. Take the money. The card never touches us — we charge the clv_ token the
  //    browser minted in the Clover iframe (SAQ-A).
  const amountCents = draft.totals.totalCents + input.tipCents;
  let charge: { id: string; status: string; paid: boolean };
  try {
    charge = await services.cloverEcommerce.charge({
      amountCents,
      currency: (draft.totals.currency || "USD").toLowerCase(),
      sourceToken: input.paymentToken,
      idempotencyKey: input.idempotencyKey,
      clientIp: input.clientIp,
    });
  } catch (err) {
    log.warn({ err }, "checkout: charge call failed");
    throw new CheckoutError("payment_failed", "Your card could not be charged.", { cause: err });
  }
  if (!charge.paid) {
    throw new CheckoutError("payment_failed", "Your card was declined.");
  }

  // 2. Money is taken — from here, ANY failure must refund (compensation).
  try {
    const orderCart = buildOrderCart(draft.lines, config.orderTypeId);
    const orderResponse = await services.clover.createAtomicOrder(merchantId, orderCart);
    const cloverOrderId = asString(orderResponse.id);
    if (!cloverOrderId) {
      throw new Error("Clover atomic order returned no id.");
    }

    // Attach the customer + phone (the loyalty key). Best-effort: a failure here
    // forfeits loyalty for this order but must NOT fail the order — the food
    // still needs to be made and the customer has paid.
    const { customerName, customerPhone } = draft.order;
    if (customerName || customerPhone) {
      try {
        const customer = await services.clover.createCustomer(merchantId, {
          firstName: customerName,
          phoneNumber: customerPhone,
        });
        const customerId = asString(customer.id);
        if (customerId) {
          await services.clover.attachCustomerToOrder(merchantId, cloverOrderId, customerId);
        }
      } catch (customerErr) {
        log.warn(
          { customerErr, cloverOrderId },
          "checkout: customer attach failed (order still placed, loyalty forfeited)",
        );
      }
    }

    // Record the externally-processed payment → the order flips to PAID → KDS.
    await services.clover.recordOrderPayment(merchantId, cloverOrderId, {
      amount: draft.totals.totalCents,
      tipAmount: input.tipCents,
      tenderId: config.tenderId,
    });

    return { cloverOrderId, chargeId: charge.id };
  } catch (err) {
    log.error({ err, chargeId: charge.id }, "checkout: order failed after charge — refunding");
    try {
      await services.cloverEcommerce.refund(charge.id);
    } catch (refundErr) {
      // The order AND the refund failed: money is held with no order. This is the
      // one outcome that needs a human.
      log.error(
        { refundErr, chargeId: charge.id, amountCents },
        "checkout: REFUND FAILED after order error — manual reconciliation required",
      );
    }
    throw new CheckoutError(
      "order_failed",
      "We couldn't place your order; your payment was refunded.",
      { cause: err },
    );
  }
}
