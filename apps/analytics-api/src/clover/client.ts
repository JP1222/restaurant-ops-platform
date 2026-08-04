import type { AppConfig } from "../config.js";
import { createLogger, errorMessage } from "../lib/log.js";
import { cloverV1RefundFetchFailuresTotal } from "../metrics/clover-refund-metrics.js";
import type { CloverExportType, JsonRecord } from "../types.js";
import { RateLimiter } from "./rate-limiter.js";

const log = createLogger("clover");

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

const ORDER_EXPAND = [
  "lineItems.modifications",
  "lineItems.discounts",
  "lineItems.taxRates",
  "lineItems.item",
  "discounts",
  "orderType"
].join(",");

export class CloverClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly config: AppConfig,
    private readonly merchantId: string,
    private readonly token: string
  ) {
    this.limiter = new RateLimiter(
      config.cloverRestMaxConcurrency,
      config.cloverRestRequestsPerSecond
    );
  }

  async createExport(type: CloverExportType, start: Date, end: Date): Promise<JsonRecord> {
    return this.requestJson(`/v3/merchants/${this.merchantId}/exports`, {
      method: "POST",
      body: {
        type,
        startTime: start.getTime(),
        endTime: end.getTime()
      }
    });
  }

  async getExport(exportId: string): Promise<JsonRecord> {
    return this.requestJson(`/v3/merchants/${this.merchantId}/exports/${exportId}`);
  }

  async downloadExportUrl(url: string): Promise<Buffer> {
    const response = await this.fetchWithRetry(url, {
      headers: {
        accept: "*/*"
      }
    });
    if (!response.ok) {
      throw new Error(`Clover export download failed with ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listV3Collection(path: string): Promise<JsonRecord[]> {
    const rows: JsonRecord[] = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const payload = await this.requestJson(`${path}${separator}limit=${limit}&offset=${offset}`);
      const elements = Array.isArray(payload.elements) ? payload.elements : [];
      rows.push(...elements.filter((entry): entry is JsonRecord => isRecord(entry)));
      if (elements.length < limit) {
        return rows;
      }
      offset += limit;
    }
  }

  async tryListV1Refunds(): Promise<JsonRecord[]> {
    try {
      const payload = await this.requestJson(`/v1/refunds?limit=100`);
      const data = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.elements) ? payload.elements : [];
      return data.filter((entry): entry is JsonRecord => isRecord(entry));
    } catch (error) {
      // GH #469: swallow so the dimension sweep still proceeds, but make the
      // failure observable — without this counter a fetch error is silently
      // indistinguishable from "no refunds" and undercounts refunds.
      cloverV1RefundFetchFailuresTotal.inc({ merchant_id: this.merchantId });
      log.error("Clover v1 refunds pull failed; treating as empty (refund undercount risk)", {
        merchantId: this.merchantId,
        error: errorMessage(error)
      });
      return [];
    }
  }

  async fetchOrderWithDetails(orderId: string): Promise<JsonRecord> {
    return this.requestJson(
      `/v3/merchants/${this.merchantId}/orders/${orderId}?expand=${encodeURIComponent(ORDER_EXPAND)}`
    );
  }

  async fetchPaymentWithDetails(paymentId: string): Promise<JsonRecord> {
    return this.requestJson(
      `/v3/merchants/${this.merchantId}/payments/${paymentId}?expand=tender,order,refunds,employee`
    );
  }

  async listOrdersForWindow(start: Date, end: Date): Promise<JsonRecord[]> {
    const query = timeFilterQuery("modifiedTime", start, end);
    return this.listV3Collection(
      `/v3/merchants/${this.merchantId}/orders?${query}&expand=${encodeURIComponent(ORDER_EXPAND)}`
    );
  }

  async listPaymentsForWindow(start: Date, end: Date): Promise<JsonRecord[]> {
    const query = timeFilterQuery("modifiedTime", start, end);
    return this.listV3Collection(
      `/v3/merchants/${this.merchantId}/payments?${query}&expand=tender,order,refunds,employee`
    );
  }

  // Filters on createdTime (transaction time) rather than modifiedTime — the
  // external-recon control total must bucket payments by the SAME field the mart
  // loader uses for business_date (normalizePayment: createdTime ?? clientCreatedTime),
  // so a payment created in the day but modified later still counts toward that day.
  async listPaymentsByCreatedTime(start: Date, end: Date): Promise<JsonRecord[]> {
    const query = timeFilterQuery("createdTime", start, end);
    return this.listV3Collection(`/v3/merchants/${this.merchantId}/payments?${query}`);
  }

  private async requestJson(path: string, options: RequestOptions = {}): Promise<JsonRecord> {
    const url = path.startsWith("http") ? path : `${this.config.cloverBaseUrl}${path}`;
    const response = await this.fetchWithRetry(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      throw new Error(`Clover request failed with ${response.status} for ${redactPath(path)}.`);
    }

    return (await response.json()) as JsonRecord;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    while (true) {
      const response = await this.limiter.schedule(() =>
        fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${this.token}`
          }
        })
      );

      if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= 8) {
        return response;
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactPath(path: string) {
  try {
    const url = new URL(path);
    return `${url.origin}${url.pathname}`;
  } catch {
    return path.split("?")[0] ?? path;
  }
}

function timeFilterQuery(field: string, start: Date, end: Date) {
  const filters = [
    `${field}>=${start.getTime()}`,
    `${field}<${end.getTime()}`
  ];
  return filters.map((filter) => `filter=${encodeURIComponent(filter)}`).join("&");
}
