// In-process sliding-window rate limiter.
// Good for a single instance. For horizontal scaling swap the store for Redis
// (same interface: hit(bucket, key) -> retry-after seconds | null).

export interface Rule {
  limit: number;
  windowSeconds: number;
}

export const RULES: Record<string, Rule> = {
  login: { limit: 10, windowSeconds: 60 },
  register: { limit: 5, windowSeconds: 600 },
  password: { limit: 5, windowSeconds: 600 },
  write: { limit: 120, windowSeconds: 60 },
  upload: { limit: 30, windowSeconds: 60 },
  checkout: { limit: 10, windowSeconds: 60 },
  review: { limit: 10, windowSeconds: 3600 },
};

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(public enabled = true) {}

  /** Record a hit. Returns seconds to wait if the caller is over the limit. */
  hit(bucket: string, key: string): number | null {
    if (!this.enabled) return null;
    const rule = RULES[bucket];
    if (!rule) throw new Error(`Unknown rate-limit bucket ${bucket}`);
    const now = performance.now() / 1000;
    const id = `${bucket}\u0000${key}`;
    let window = this.hits.get(id);
    if (!window) {
      window = [];
      this.hits.set(id, window);
    }
    while (window.length && now - window[0] > rule.windowSeconds) window.shift();
    if (window.length >= rule.limit) {
      return Math.max(1, Math.floor(rule.windowSeconds - (now - window[0])) + 1);
    }
    window.push(now);
    if (this.hits.size > 50_000) this.gc(now); // bound memory under key-spraying
    return null;
  }

  private gc(now: number): void {
    const longest = Math.max(...Object.values(RULES).map((r) => r.windowSeconds));
    for (const [k, v] of this.hits) {
      if (!v.length || now - v[v.length - 1] > longest) this.hits.delete(k);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}
