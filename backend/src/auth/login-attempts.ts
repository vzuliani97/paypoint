/**
 * Slows down password guessing. After `maxFailures` failed logins for one email from one address
 * within the window, that pair is locked until the window ends, even for the right password.
 * Kept in memory: each API replica counts on its own, so several replicas would need a shared store.
 */
export class LoginAttempts {
  private readonly failures = new Map<string, { count: number; firstAt: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until this pair may try again, or 0 when it is not locked. */
  lockedFor(key: string): number {
    const entry = this.current(key);
    if (!entry || entry.count < this.maxFailures) return 0;
    return Math.ceil((entry.firstAt + this.windowMs - this.now()) / 1000);
  }

  recordFailure(key: string): void {
    const entry = this.current(key) ?? { count: 0, firstAt: this.now() };
    entry.count += 1;
    this.failures.set(key, entry);
    // Bounded memory: drop expired entries, then the oldest ones (a Map keeps insertion order).
    if (this.failures.size > this.maxKeys) {
      for (const stored of [...this.failures.keys()]) this.current(stored);
      for (const oldest of this.failures.keys()) {
        if (this.failures.size <= this.maxKeys) break;
        this.failures.delete(oldest);
      }
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private current(key: string) {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.firstAt >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }
}
