// Request pacing and timeout helpers for the Meterless Runtime client.

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlidingWindowLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0] ?? now;
      await this.sleep(Math.max(1, this.windowMs - (now - oldest)));
    }
  }
}
