// 金额统一以「分」为单位的整数存储与传输，避免浮点误差。
// 客户端负责按币种本地化展示。

export function toYuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return sign + (abs / 100).toFixed(2);
}

export function parseAmount(input: unknown): number {
  const n = Number(input);
  if (!Number.isInteger(n)) {
    throw new Error("金额必须是整数（分）");
  }
  return n;
}

export function positiveCents(input: unknown): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("金额必须是大于 0 的整数（分）");
  }
  return n;
}
