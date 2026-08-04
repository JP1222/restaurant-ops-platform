import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { handleMetrics } from "../src/http/metrics.js";

describe("/metrics", () => {
  it("serves prom-client default metrics in the Prometheus text format", async () => {
    const { res, body } = httpRes();

    await handleMetrics(res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    // nodejs_version_info and process_start_time_seconds are emitted by
    // collectDefaultMetrics on every platform, so they assert the endpoint is
    // wired without depending on the macOS CI runner's process-metric set.
    expect(body.value).toContain("nodejs_version_info");
    expect(body.value).toContain("process_start_time_seconds");
  });
});

function httpRes() {
  const body = { value: "" };
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    end(chunk = "") {
      body.value = chunk;
    },
  } as ServerResponse & { headers: Record<string, string> };

  return { res, body };
}
