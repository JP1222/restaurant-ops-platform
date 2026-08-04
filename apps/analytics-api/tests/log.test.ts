import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, errorMessage } from "../src/lib/log.js";
import { requestContext } from "../src/lib/request-context.js";

type Captured = { stream: "log" | "warn" | "error"; line: string };

function captureConsole() {
  const captured: Captured[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    captured.push({ stream: "log", line });
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((line: string) => {
    captured.push({ stream: "warn", line });
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => {
    captured.push({ stream: "error", line });
  });
  return {
    captured,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured logger", () => {
  it("emits a single JSON line parseable like jq with the prescribed envelope", () => {
    const cap = captureConsole();
    const log = createLogger("clover");
    log.info("Received Clover webhook verification code");
    cap.restore();

    expect(cap.captured).toHaveLength(1);
    const parsed = JSON.parse(cap.captured[0]!.line);
    expect(parsed).toEqual({
      level: "info",
      scope: "analytics.service.clover",
      message: "Received Clover webhook verification code"
    });
  });

  it("namespaces the scope under analytics.service.<subsystem>", () => {
    const cap = captureConsole();
    createLogger("scheduler.heartbeat").error("boom");
    cap.restore();
    const parsed = JSON.parse(cap.captured[0]!.line);
    // Mirrors the Loki query `|= "analytics.service.clover" | json level`.
    expect(parsed.scope).toBe("analytics.service.scheduler.heartbeat");
    expect(parsed.level).toBe("error");
  });

  it("does not double-prefix an already-namespaced subsystem", () => {
    const cap = captureConsole();
    createLogger("analytics.service.migrate").info("hi");
    cap.restore();
    expect(JSON.parse(cap.captured[0]!.line).scope).toBe("analytics.service.migrate");
  });

  it("includes context only when non-empty", () => {
    const cap = captureConsole();
    const log = createLogger("backfill");
    log.info("with ctx", { runId: "r1" });
    log.info("without ctx", {});
    cap.restore();
    expect(JSON.parse(cap.captured[0]!.line).context).toEqual({ runId: "r1" });
    expect(JSON.parse(cap.captured[1]!.line)).not.toHaveProperty("context");
  });

  it("routes error to console.error and warn to console.warn for Loki level fields", () => {
    const cap = captureConsole();
    const log = createLogger("scheduler");
    log.warn("a warning");
    log.error("an error");
    log.info("an info");
    cap.restore();
    expect(cap.captured.map((c) => c.stream)).toEqual(["warn", "error", "log"]);
  });

  it("redacts secrets in the message so tokens never reach the log line", () => {
    const cap = captureConsole();
    const log = createLogger("clover");
    log.error("Skipping v1 refunds pull: 401 from Bearer eyJhbGciOiJ.tok.sig");
    cap.restore();
    const parsed = JSON.parse(cap.captured[0]!.line);
    expect(parsed.message).not.toContain("eyJhbGciOiJ");
    expect(parsed.message).toContain("[REDACTED]");
  });

  it("redacts connection strings surfaced by pg errors", () => {
    const cap = captureConsole();
    createLogger("service").error(
      errorMessage(new Error("connect ECONNREFUSED postgres://u:p4ss@db:5432/analytics"))
    );
    cap.restore();
    expect(cap.captured[0]!.line).not.toContain("p4ss");
    expect(cap.captured[0]!.line).toContain("[REDACTED]");
  });

  it("includes the request-scope correlation id, and omits it outside a request", () => {
    const cap = captureConsole();
    requestContext.run({ requestId: "rid-123" }, () => {
      createLogger("clover").info("inside a request");
    });
    createLogger("clover").info("outside a request");
    cap.restore();
    expect(JSON.parse(cap.captured[0]!.line).requestId).toBe("rid-123");
    expect(JSON.parse(cap.captured[1]!.line)).not.toHaveProperty("requestId");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    expect(errorMessage(new Error("nope"))).toBe("nope");
  });
  it("stringifies non-Error throwables", () => {
    expect(errorMessage("raw string")).toBe("raw string");
    expect(errorMessage(42)).toBe("42");
  });
});
