/**
 * Fixed-window rate limiter kept in process memory. Good enough for the single
 * web instance of Phase 1; a shared store replaces it when the app scales out
 * (proposal §5: rate limits on mutating APIs).
 */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  return {
    /** Counts one hit for `key`; returns seconds to wait when over the limit, else 0. */
    hit(key: string): number {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= options.windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (t - v.start >= options.windowMs) windows.delete(k);
        }
      }
      w.count += 1;
      return w.count > options.limit ? Math.ceil((w.start + options.windowMs - t) / 1000) : 0;
    },
  };
}
