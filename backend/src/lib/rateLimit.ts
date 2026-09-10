// 简单的进程内滑窗限流（单实例部署场景够用；多实例需换 Redis/共享存储）。

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export interface RateLimiterFn {
  (key: string): { allowed: boolean; remaining: number };
  /** 归还一个额度：用于"外部调用失败不该扣配额"的场景（如短信真实外呼失败） */
  refund(key: string): void;
  /** 当前窗口内已用计数（供测试观测） */
  countOf(key: string): number;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiterFn {
  const buckets = new Map<string, Bucket>();

  function prune(now: number) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= opts.windowMs) buckets.delete(k);
    }
  }

  const check = function check(key: string): { allowed: boolean; remaining: number } {
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
  } as RateLimiterFn;

  // 归还一个额度：真实外呼失败时把刚占用的配额还回去，避免"发送失败还扣额度"误伤用户。
  // 窗口起点保持不变，因此不能靠反复失败来绕开冷却窗口。
  check.refund = (key: string): void => {
    const b = buckets.get(key);
    if (b && b.count > 0) b.count -= 1;
  };

  check.countOf = (key: string): number => buckets.get(key)?.count ?? 0;

  return check;
}
