import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  CloverEcommerceClient,
  CloverEcommerceError,
} from "../src/lib/clover-ecommerce.js";

// The client reads only the ecommerce fields off config; a focused fake keeps
// the test readable. (kds-api test files are not type-checked by the build —
// tsconfig `include` is `src/**` only — so the partial cast is safe here.)
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    cloverEcommApiBaseUrl: "https://scl-sandbox.dev.clover.com",
    cloverEcommPublicKey: "pk_test_public",
    cloverEcommPrivateKey: "sk_test_private",
    ...overrides,
  } as unknown as AppConfig;
}

function mockJsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CloverEcommerceClient", () => {
  it("charges /v1/charges on the ecommerce host with the private key + required headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse(200, { id: "ch_1", status: "succeeded", paid: true, amount: 1100 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloverEcommerceClient(makeConfig());
    const result = await client.charge({
      amountCents: 1100,
      currency: "usd",
      sourceToken: "clv_test_token",
      idempotencyKey: "checkout-abc",
      clientIp: "1.2.3.4",
    });

    expect(result).toEqual({ id: "ch_1", status: "succeeded", paid: true, amountCents: 1100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://scl-sandbox.dev.clover.com/v1/charges");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_private");
    expect(headers["x-forwarded-for"]).toBe("1.2.3.4");
    expect(headers["idempotency-key"]).toBe("checkout-abc");
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 1100,
      currency: "usd",
      source: "clv_test_token",
      ecomind: "ecom",
      capture: true,
    });
  });

  it("throws when the private key is not configured", async () => {
    const client = new CloverEcommerceClient(makeConfig({ cloverEcommPrivateKey: undefined }));
    await expect(
      client.charge({
        amountCents: 1100,
        currency: "usd",
        sourceToken: "clv_x",
        idempotencyKey: "k",
        clientIp: "1.2.3.4",
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it("throws CloverEcommerceError on a non-2xx and never leaks the card token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(402, { error: { message: "card declined" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloverEcommerceClient(makeConfig());
    const error = await client
      .charge({
        amountCents: 500,
        currency: "usd",
        sourceToken: "clv_secret_token",
        idempotencyKey: "k2",
        clientIp: "1.2.3.4",
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CloverEcommerceError);
    expect((error as CloverEcommerceError).status).toBe(402);
    expect(String((error as Error).message)).not.toContain("clv_secret_token");
  });

  it("reports configured + exposes the browser public key from config", () => {
    expect(new CloverEcommerceClient(makeConfig()).configured).toBe(true);
    expect(new CloverEcommerceClient(makeConfig()).publicKey).toBe("pk_test_public");
    expect(
      new CloverEcommerceClient(makeConfig({ cloverEcommPrivateKey: undefined })).configured,
    ).toBe(false);
  });
});
