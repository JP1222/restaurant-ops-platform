import { describe, expect, it } from "vitest";
import { scrubEvent } from "./sentry-scrub.js";

describe("scrubEvent", () => {
  it("redacts customer PII in request.data", () => {
    const event = {
      request: {
        data: {
          orderId: "abc",
          customerName: "Jane Doe",
          customerPhone: "555-0100",
          customer_email: "jane@example.com",
        },
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request?.data).toMatchObject({
      orderId: "abc",
      customerName: "[redacted]",
      customerPhone: "[redacted]",
      customer_email: "[redacted]",
    });
  });

  it("redacts Square + generic access tokens in request.data", () => {
    const event = {
      request: {
        data: {
          merchantId: "MER123",
          environment: "sandbox",
          squareAccessToken: "EAAA-super-secret-pat",
          accessToken: "another-secret",
          access_token: "snake-secret",
        },
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request?.data).toMatchObject({
      merchantId: "MER123",
      environment: "sandbox",
      squareAccessToken: "[redacted]",
      accessToken: "[redacted]",
      access_token: "[redacted]",
    });
  });

  it("redacts authorization + cookie + x-*-token headers", () => {
    const event = {
      request: {
        headers: {
          Authorization: "Bearer secret",
          cookie: "session=abc",
          "X-Internal-Admin-Token": "tok",
          "X-Trace-Id": "ok-to-keep",
        },
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request?.headers).toMatchObject({
      Authorization: "[redacted]",
      cookie: "[redacted]",
      "X-Internal-Admin-Token": "[redacted]",
      "X-Trace-Id": "ok-to-keep",
    });
  });

  it("strips request.cookies entirely", () => {
    const event = { request: { cookies: { session: "abc" }, data: {} } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request?.cookies).toBeUndefined();
  });

  it("recursively scrubs nested objects", () => {
    const event = {
      extra: {
        order: {
          items: [{ name: "burger" }],
          customer: { customerName: "Jane", customer_phone: "555" },
        },
      },
    };
    const scrubbed = scrubEvent(event);
    const order = (scrubbed.extra?.order as Record<string, unknown>) ?? {};
    expect((order.customer as Record<string, unknown>).customerName).toBe("[redacted]");
    expect((order.customer as Record<string, unknown>).customer_phone).toBe("[redacted]");
  });

  it("redacts provider tokens (cloverToken, deliverectToken)", () => {
    const event = {
      extra: {
        cloverToken: "tok-1",
        deliverect_token: "tok-2",
        deliverectWebhookSecret: "tok-3",
        nonSensitive: "keep",
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra).toMatchObject({
      cloverToken: "[redacted]",
      deliverect_token: "[redacted]",
      deliverectWebhookSecret: "[redacted]",
      nonSensitive: "keep",
    });
  });

  it("strips user.email / user.username / user.ip_address", () => {
    const event = {
      user: {
        id: "u-1",
        email: "jane@example.com",
        username: "jane",
        ip_address: "1.2.3.4",
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.user).toEqual({ id: "u-1" });
  });

  it("passes non-PII through untouched", () => {
    const event = {
      extra: { route: "/api/kds/tickets", merchantId: "m-1", count: 5 },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra).toEqual({
      route: "/api/kds/tickets",
      merchantId: "m-1",
      count: 5,
    });
  });

  it("scrubs PII inside arrays of objects", () => {
    const event = {
      extra: {
        guests: [
          { id: 1, customerName: "Alice" },
          { id: 2, customerName: "Bob" },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    const guests = (scrubbed.extra?.guests ?? []) as Array<Record<string, unknown>>;
    expect(guests).toHaveLength(2);
    expect(guests[0]?.customerName).toBe("[redacted]");
    expect(guests[1]?.customerName).toBe("[redacted]");
    expect(guests[0]?.id).toBe(1);
  });

  it("redacts DATABASE_URL / REDIS_URL by key name", () => {
    const event = {
      extra: {
        DATABASE_URL: "postgresql://postgres:secret@postgres-kds:5432/db",
        REDIS_URL: "redis://:authpass@redis-kds:6379",
        databaseUrl: "postgresql://u:p@h/d",
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra).toMatchObject({
      DATABASE_URL: "[redacted]",
      REDIS_URL: "[redacted]",
      databaseUrl: "[redacted]",
    });
  });

  it("redacts a 32-byte hex secret inside an exception value", () => {
    const key = "a".repeat(64);
    const event = { exception: { values: [{ type: "Error", value: `boom with key ${key} trailing` }] } };
    const scrubbed = scrubEvent(event) as { exception: { values: Array<{ value: string }> } };
    expect(scrubbed.exception.values[0]?.value).toBe("boom with key [redacted] trailing");
  });

  it("redacts connection-string credentials in the message, keeping scheme+host", () => {
    const event = { message: "connect failed: postgresql://postgres:secret@postgres-kds:5432/rop_kds" };
    const scrubbed = scrubEvent(event) as { message: string };
    expect(scrubbed.message).toBe("connect failed: postgresql://[redacted]@postgres-kds:5432/rop_kds");
  });

  it("scrubs secret-shaped values under innocuous keys + in query_string", () => {
    const key = "b".repeat(64);
    const event = {
      request: { query_string: `token=${key}&page=2` },
      extra: { dsn: "redis://:p4ss@redis-kds:6379" },
    };
    const scrubbed = scrubEvent(event) as {
      request: { query_string: string };
      extra: { dsn: string };
    };
    expect(scrubbed.request.query_string).toBe("token=[redacted]&page=2");
    expect(scrubbed.extra.dsn).toBe("redis://[redacted]@redis-kds:6379");
  });

  it("leaves non-secret strings (short hashes, credential-less URLs) untouched", () => {
    const event = {
      extra: {
        gitSha: "a".repeat(40), // 40-char, not 64 → keep
        redisHost: "redis://redis-kds:6379", // no credentials → keep
        path: "/api/kds/tickets",
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.extra).toEqual({
      gitSha: "a".repeat(40),
      redisHost: "redis://redis-kds:6379",
      path: "/api/kds/tickets",
    });
  });
});
