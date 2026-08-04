import { hostname } from "node:os";
import type { Redis } from "ioredis";

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_TTL_MS = 30_000;
const WORKER_HEARTBEAT_PATTERN = "kds:worker:*:heartbeat";

export type WorkerHeartbeat = {
  workerId: string;
  pid: number;
  host: string;
  at: string;
};

export function defaultWorkerId() {
  return `${hostname()}:${process.pid}`;
}

export function workerHeartbeatKey(workerId: string) {
  return `kds:worker:${workerId}:heartbeat`;
}

export async function writeWorkerHeartbeat(redis: Redis, workerId = defaultWorkerId(), now = new Date()) {
  const payload: WorkerHeartbeat = {
    workerId,
    pid: process.pid,
    host: hostname(),
    at: now.toISOString()
  };
  await redis.set(workerHeartbeatKey(workerId), JSON.stringify(payload), "PX", WORKER_HEARTBEAT_TTL_MS);
  return payload;
}

export function startWorkerHeartbeat(redis: Redis, workerId = defaultWorkerId()) {
  void writeWorkerHeartbeat(redis, workerId);
  const timer = setInterval(() => {
    void writeWorkerHeartbeat(redis, workerId);
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  return () => {
    clearInterval(timer);
  };
}

export async function readActiveWorkerHeartbeats(redis: Redis) {
  const keys = await redis.keys(WORKER_HEARTBEAT_PATTERN);
  if (keys.length === 0) {
    return [];
  }

  const values = await redis.mget(...keys);
  return values.flatMap((value) => {
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value) as WorkerHeartbeat;
      return parsed.workerId && parsed.at ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
