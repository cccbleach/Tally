// 进程内一次性验证码（OTP）存储。单实例部署足够；多实例需换共享存储/Redis。
// 验证码以 SHA-256 哈希保存，内存中不存明文。

import { createHash } from "node:crypto";

export interface OtpOptions {
  ttlMs: number;
  length: number;
  maxAttempts: number;
}

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

interface Entry {
  code: string;
  expiresAt: number;
  attempts: number;
}

export function createOtpStore(opts: Partial<OtpOptions> = {}) {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const length = opts.length ?? 6;
  const maxAttempts = opts.maxAttempts ?? 3;
  const store = new Map<string, Entry>();

  function cleanup(now: number) {
    for (const [k, v] of store) {
      if (now > v.expiresAt) store.delete(k);
    }
  }

  return {
    // 生成并返回验证码（生产应通过短信发送）
    generate(key: string): string {
      const now = Date.now();
      cleanup(now);
      const code = String(Math.floor(Math.random() * 10 ** length)).padStart(length, "0");
      store.set(key, { code: hash(code), expiresAt: now + ttlMs, attempts: 0 });
      return code;
    },
    // 存入外部（如短信服务）生成的验证码，仍沿用本地的过期/尝试次数校验
    store(key: string, code: string): void {
      const now = Date.now();
      cleanup(now);
      store.set(key, { code: hash(code), expiresAt: now + ttlMs, attempts: 0 });
    },
    verify(key: string, input: string): { ok: boolean; reason?: "expired" | "invalid" | "exhausted" } {
      const now = Date.now();
      const e = store.get(key);
      if (!e || now > e.expiresAt) return { ok: false, reason: "expired" };
      if (e.attempts >= maxAttempts) return { ok: false, reason: "exhausted" };
      if (e.code !== hash(input)) {
        e.attempts += 1;
        if (e.attempts >= maxAttempts) store.delete(key);
        return { ok: false, reason: "invalid" };
      }
      store.delete(key);
      return { ok: true };
    },
  };
}

export type OtpStore = ReturnType<typeof createOtpStore>;
