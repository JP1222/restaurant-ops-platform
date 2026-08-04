import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../src/lib/services.js";
import type { OrderDraft } from "../src/lib/order-draft.js";
import { checkoutOrder } from "../src/lib/order-checkout.js";

const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof checkoutOrder>[1]["log"];

const DRAFT: OrderDraft = {
  merchantId: "M1",
  order: { customerName: "Jamie", customerPhone: "+19015550100", lines: [] },
  lines: [{ name: "Roll", unitPriceCents: 899, quantity: 1, modifierNames: [] }],
  totals: { subtotalCents: 899, taxCents: 0, tipCents: 0, totalCents: 899, currency: "USD" },
};

function makeServices(
  over: {
    charge?: ReturnType<typeof vi.fn>;
    refund?: ReturnType<typeof vi.fn>;
    createAtomicOrder?: ReturnType<typeof vi.fn>;
    recordOrderPayment?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const cloverEcommerce = {
    configured: true,
    charge:
      over.charge ??
      vi.fn().mockResolvedValue({ id: "ch1", status: "succeeded", paid: true, amountCents: 999 }),
    refund: over.refund ?? vi.fn().mockResolvedValue({ id: "re1", status: "succeeded" }),
  };
  const clover = {
    createAtomicOrder: over.createAtomicOrder ?? vi.fn().mockResolvedValue({ id: "ORDER1" }),
    createCustomer: vi.fn().mockResolvedValue({ id: "CUST1" }),
    attachCustomerToOrder: vi.fn().mockResolvedValue({}),
    recordOrderPayment: over.recordOrderPayment ?? vi.fn().mockResolvedValue({ id: "pay1" }),
  };
  return { services: { cloverEcommerce, clover } as unknown as AppServices, cloverEcommerce, clover };
}

function input(config: { orderTypeId: string | null; tenderId: string } = { orderTypeId: null, tenderId: "T1" }) {
  return {
    merchantId: "M1",
    draft: DRAFT,
    config,
    paymentToken: "clv_x",
    tipCents: 100,
    clientIp: "1.2.3.4",
    idempotencyKey: "k",
    log,
  };
}

afterEach(() => vi.clearAllMocks());

describe("checkoutOrder", () => {
  it("charges, creates the order, attaches the customer, and records the payment", async () => {
    const { services, cloverEcommerce, clover } = makeServices();

    const result = await checkoutOrder(services, input());

    expect(result).toEqual({ cloverOrderId: "ORDER1", chargeId: "ch1" });
    // 899 total + 100 tip = 999 charged.
    expect(cloverEcommerce.charge).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 999, sourceToken: "clv_x", clientIp: "1.2.3.4", idempotencyKey: "k" }),
    );
    expect(clover.attachCustomerToOrder).toHaveBeenCalledWith("M1", "ORDER1", "CUST1");
    // The order amount excludes tip; tip rides on the payment.
    expect(clover.recordOrderPayment).toHaveBeenCalledWith(
      "M1",
      "ORDER1",
      expect.objectContaining({ amount: 899, tipAmount: 100, tenderId: "T1" }),
    );
    expect(cloverEcommerce.refund).not.toHaveBeenCalled();
  });

  it("throws payment_failed and never creates an order when the charge is declined", async () => {
    const { services, clover } = makeServices({
      charge: vi.fn().mockResolvedValue({ id: "ch1", status: "declined", paid: false, amountCents: 0 }),
    });

    await expect(checkoutOrder(services, input())).rejects.toMatchObject({ code: "payment_failed" });
    expect(clover.createAtomicOrder).not.toHaveBeenCalled();
  });

  it("refunds the charge when order creation fails after payment (compensation)", async () => {
    const { services, cloverEcommerce } = makeServices({
      createAtomicOrder: vi.fn().mockRejectedValue(new Error("clover 500")),
    });

    await expect(checkoutOrder(services, input())).rejects.toMatchObject({ code: "order_failed" });
    expect(cloverEcommerce.refund).toHaveBeenCalledWith("ch1");
  });

  it("refunds when recording the payment fails after the order was created", async () => {
    const { services, cloverEcommerce } = makeServices({
      recordOrderPayment: vi.fn().mockRejectedValue(new Error("pay fail")),
    });

    await expect(checkoutOrder(services, input())).rejects.toMatchObject({ code: "order_failed" });
    expect(cloverEcommerce.refund).toHaveBeenCalledWith("ch1");
  });

  it("still places the order when the customer attach fails (loyalty forfeited, not the order)", async () => {
    const { services, clover, cloverEcommerce } = makeServices();
    (clover.createCustomer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("customer 500"));

    const result = await checkoutOrder(services, input());

    expect(result.cloverOrderId).toBe("ORDER1");
    expect(clover.recordOrderPayment).toHaveBeenCalled(); // order still settled
    expect(cloverEcommerce.refund).not.toHaveBeenCalled(); // not a refund-worthy failure
  });
});
