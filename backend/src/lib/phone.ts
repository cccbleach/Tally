// 手机号归一化：仅支持中国大陆 11 位手机号，统一存为 +86 E.164。
// 输入允许：13800000001、+8613800000001、138 0000 0001、+86 13800000001。
// 返回 E.164 字符串；不合法返回 null。

// 中国大陆手机号：1 开头，第二位 3-9，共 11 位。
const CN_MOBILE = /^1[3-9]\d{9}$/;

export function normalizePhone(input: string): string | null {
  if (!input) return null;
  const t = input.trim().replace(/[\s-]/g, "");
  let digits: string;
  if (/^\+86/.test(t)) {
    digits = t.slice(3);
  } else if (/^86/.test(t)) {
    digits = t.slice(2);
  } else {
    digits = t;
  }
  if (!CN_MOBILE.test(digits)) return null;
  return "+86" + digits;
}

// 手机号脱敏展示：+8613800000001 → +86 138****0001
export function maskPhone(phone: string): string {
  const m = /^(\+\d{2})(1\d{2})\d{4}(\d{4})$/.exec(phone);
  if (!m) return phone;
  return `${m[1]} ${m[2]}****${m[3]}`;
}
