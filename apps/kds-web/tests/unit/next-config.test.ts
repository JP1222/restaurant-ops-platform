import { describe, expect, it } from "vitest";
import { buildRewrites } from "../../next.config";

describe("next config rewrites", () => {
  it("proxies both HTTP API and realtime WebSocket paths to the API server", () => {
    expect(buildRewrites("http://127.0.0.1:4000")).toEqual([
      {
        source: "/ws",
        destination: "http://127.0.0.1:4000/ws"
      },
      {
        source: "/ws/:path*",
        destination: "http://127.0.0.1:4000/ws/:path*"
      },
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:4000/api/:path*"
      }
    ]);
  });
});
