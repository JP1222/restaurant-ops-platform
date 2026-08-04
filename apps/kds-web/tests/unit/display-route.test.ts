import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_MERCHANT_COOKIE_NAME, DEVICE_TOKEN_COOKIE_NAME } from "@/lib/device-cookie";
import DisplayPage from "@/app/display/page";

// DisplayPage reads cookies() (device-pairing precedence), which throws outside a
// request scope — so mock next/headers with a per-test cookie jar. vi.hoisted lets
// the (hoisted) mock factory reference the jar without a temporal-dead-zone error.
const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    }
  })
}));

vi.mock("@/components/customer-display-screen", () => ({
  CustomerDisplayScreen: () => null
}));

describe("display route", () => {
  beforeEach(() => {
    cookieJar.clear();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEFAULT_MERCHANT_ID;
  });

  it("renders the public display shell without requiring a merchant query", async () => {
    const element = await DisplayPage({
      searchParams: Promise.resolve({})
    });

    expect(element.props.initialMerchantId).toBe("");
  });

  it("uses query merchantId before the public default merchant", async () => {
    process.env.NEXT_PUBLIC_DEFAULT_MERCHANT_ID = "default-merchant";
    const element = await DisplayPage({
      searchParams: Promise.resolve({
        merchantId: "query-merchant"
      })
    });

    expect(element.props.initialMerchantId).toBe("query-merchant");
  });

  it("falls back to NEXT_PUBLIC_DEFAULT_MERCHANT_ID when merchantId is absent", async () => {
    process.env.NEXT_PUBLIC_DEFAULT_MERCHANT_ID = "default-merchant";
    const element = await DisplayPage({
      searchParams: Promise.resolve({})
    });

    expect(element.props.initialMerchantId).toBe("default-merchant");
  });

  it("scopes to the paired device's bound store (cookie wins over ?merchantId=)", async () => {
    cookieJar.set(DEVICE_TOKEN_COOKIE_NAME, "yrkds_example");
    cookieJar.set(DEVICE_MERCHANT_COOKIE_NAME, "device-store");
    const element = await DisplayPage({
      searchParams: Promise.resolve({ merchantId: "query-merchant" })
    });

    expect(element.props.initialMerchantId).toBe("device-store");
  });

  it("ignores a stale merchant cookie when no device token is present (stays on the public path)", async () => {
    cookieJar.set(DEVICE_MERCHANT_COOKIE_NAME, "device-store");
    const element = await DisplayPage({
      searchParams: Promise.resolve({ merchantId: "query-merchant" })
    });

    expect(element.props.initialMerchantId).toBe("query-merchant");
  });
});
