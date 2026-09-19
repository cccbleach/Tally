import { createHash } from "node:crypto";

// 去除常见平台前缀/符号/空白，保留核心商家词，降低“微信 vs 银行”写法差异
export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw
    .replace(/微信转账|支付宝|银联|快捷支付|无卡自助消费|（特约）|\(特约\)|商户|消费|退款|转账|还款/g, " ")
    .replace(/[\s，。！？、（）()【】\[\]【】:：,.;;·_-]/g, " ")
    .toLowerCase()
    .trim();
  // 压缩空白
  s = s.replace(/\s+/g, " ");
  // 取最长连续中文/数字/字母片段作为核心词（简单策略：取前 12 个字符）
  return s.slice(0, 12);
}

// 生成跨来源去重指纹：日期(±1天) + 金额(分) + 规范化商家
//
// 载荷里的 "CNY" 是**历史格式的保留字面量**，不是可变币种：存量 dedup_key 全部是按
// `${date}|${amount}|CNY|${merchant}` 生成的（多币种年代唯一写入过的币种就是 CNY）。
// 保留它，老指纹与新指纹才仍然可比，软去重不会因为删掉币种字段而整体失效。
export function buildDedupKey(date: string, amount: number, note: string | null): string {
  const merchant = normalizeMerchant(note);
  const payload = `${date}|${amount}|CNY|${merchant}`;
  return createHash("sha1").update(payload, "utf8").digest("hex");
}
