// 简单的进程内滑窗限流（单实例部署场景够用；多实例需换 Redis/共享存储）。

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export function createRateLimiter(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  function prune(now: number) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= opts.windowMs) buckets.delete(k);
    }
  }

  return function check(key: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    if (buckets.size > 1000) prune(now); // 防内存膨胀
    const b = buckets.get(key);
    if (!b || now - b.windowStart >= opts.windowMs) {
      buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: opts.max - 1 };
    }
    if (b.count < opts.max) {
      b.count += 1;
      return { allowed: true, remaining: opts.max - b.count };
    }
    return { allowed: false, remaining: 0 };
  };
}
