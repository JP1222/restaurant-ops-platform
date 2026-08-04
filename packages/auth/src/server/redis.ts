// Minimal pipeline surface used for atomic get-and-delete (GH #477). ioredis'
// real `multi()` returns a chainable pipeline; we only need GET then DEL queued
// in one transaction, then the raw result tuples. Declared `optional` so existing
// AuthRedis stubs that predate the atomic consume keep type-checking — callers
// fall back to non-atomic get/del when `multi` is absent.
export type AuthRedisPipeline = {
  get(key: string): AuthRedisPipeline;
  del(key: string): AuthRedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
};

export type AuthRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  multi?(): AuthRedisPipeline;
};
