export class RateLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private nextAllowedAt = 0;

  constructor(
    private readonly maxConcurrency: number,
    private readonly requestsPerSecond: number
  ) {}

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.waitForRateLimit();
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  private async acquireSlot() {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private async waitForRateLimit() {
    const spacingMs = Math.ceil(1000 / this.requestsPerSecond);
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + spacingMs;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

