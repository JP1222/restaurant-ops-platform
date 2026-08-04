import { describe, expect, it, vi } from "vitest";
import {
  readActiveWorkerHeartbeats,
  WORKER_HEARTBEAT_TTL_MS,
  workerHeartbeatKey,
  writeWorkerHeartbeat
} from "../src/lib/worker-heartbeat.js";

function createRedisMock() {
  return {
    set: vi.fn(async () => "OK"),
    keys: vi.fn(async () => [] as string[]),
    mget: vi.fn(async () => [] as Array<string | null>)
  };
}

describe("worker heartbeat", () => {
  it("writes heartbeat payloads with a short TTL", async () => {
    const redis = createRedisMock();
    const now = new Date("2026-04-24T12:00:00.000Z");

    const payload = await writeWorkerHeartbeat(redis as never, "worker-1", now);

    expect(payload).toMatchObject({
      workerId: "worker-1",
      at: "2026-04-24T12:00:00.000Z"
    });
    expect(redis.set).toHaveBeenCalledWith(
      workerHeartbeatKey("worker-1"),
      JSON.stringify(payload),
      "PX",
      WORKER_HEARTBEAT_TTL_MS
    );
  });

  it("reads active heartbeats and ignores expired or malformed values", async () => {
    const redis = createRedisMock();
    redis.keys.mockResolvedValueOnce([
      workerHeartbeatKey("worker-1"),
      workerHeartbeatKey("worker-2"),
      workerHeartbeatKey("worker-3")
    ]);
    redis.mget.mockResolvedValueOnce([
      JSON.stringify({
        workerId: "worker-1",
        pid: 123,
        host: "test-host",
        at: "2026-04-24T12:00:00.000Z"
      }),
      null,
      "{bad-json"
    ]);

    await expect(readActiveWorkerHeartbeats(redis as never)).resolves.toEqual([
      {
        workerId: "worker-1",
        pid: 123,
        host: "test-host",
        at: "2026-04-24T12:00:00.000Z"
      }
    ]);
  });
});
