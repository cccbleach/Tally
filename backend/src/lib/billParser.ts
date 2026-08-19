// 账单导入解析：支持微信支付明细（txt）与支付宝交易明细（csv）。
// 按常见导出格式解析；行结构与网银/银行 App 导出的 CSV 大同小异，后续可扩展 source。

export interface ParsedBill {
  date: string; // YYYY-MM-DD
  amount: number; // 分（正数）
  type: "income" | "expense";
  note: string | null;
  externalId: string | null; // 来源流水号，用于去重
}

// 拆分一行，支持被引号包裹的字段（含逗号/换行少量场景）
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function yuanToCents(val: string | undefined): number | null {
  if (!val) return null;
  const cleaned = val.replace(/[¥￥,\s"']/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// 微信支付明细 txt
export function parseWechat(text: string): ParsedBill[] {
  const lines = text.split(/\r?\n/);
  // 找到表头：同时含“交易时间”和“金额”
  const headerIdx = lines.findIndex((l) => l.includes("交易时间") && l.includes("金额"));
  if (headerIdx < 0) return [];
  const headers = splitCsvLine(lines[headerIdx]!);
  const col = (name: string): number => headers.findIndex((h) => h.includes(name));

  const di = col("交易时间");
  const ti = col("收/支");
  const ai = col("金额");
  const ni = col("商品") >= 0 ? col("商品") : col("备注");
  const ei = col("交易单号") >= 0 ? col("交易单号") : col("商户单号");
  const si = col("当前状态");

  const items: ParsedBill[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    const typeRaw = cols[ti] ?? "";
    const type = typeRaw === "收入" ? "income" : typeRaw === "支出" ? "expense" : null;
    if (!type) continue;
    const status = si >= 0 ? (cols[si] ?? "") : "";
    if (status && !status.includes("成功")) continue; // 只导入成功流水

    const dateRaw = cols[di] ?? "";
    const cents = yuanToCents(cols[ai]);
    if (!cents || cents <= 0 || !dateRaw) continue;
    items.push({
      date: dateRaw.slice(0, 10),
      amount: cents,
      type,
      note: ni >= 0 && cols[ni] ? cols[ni] : null,
      externalId: ei >= 0 && cols[ei] ? cols[ei] : null,
    });
  }
  return items;
}

// 支付宝交易明细 csv
export function parseAlipay(text: string): ParsedBill[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.includes("金额") && l.includes("收/支"));
  if (headerIdx < 0) return [];
  const headers = splitCsvLine(lines[headerIdx]!);
  const col = (name: string): number => headers.findIndex((h) => h.includes(name));

  const diRaw = col("交易创建时间") >= 0 ? col("交易创建时间") : col("付款时间") >= 0 ? col("付款时间") : -1;
  const ti = col("收/支");
  const ai = col("金额");
  const ni = col("商品名称") >= 0 ? col("商品名称") : col("备注");
  const ei = col("交易号");
  const si = col("交易状态");

  const items: ParsedBill[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cols = splitCsvLine(line);
    const typeRaw = cols[ti] ?? "";
    const type = typeRaw === "收入" ? "income" : typeRaw === "支出" ? "expense" : null;
    if (!type) continue;
    const status = si >= 0 ? (cols[si] ?? "") : "";
    if (status && status !== "交易成功" && !status.includes("成功")) continue;

    const dateRaw = cols[diRaw] ?? "";
    const cents = yuanToCents(cols[ai]);
    if (!cents || cents <= 0 || !dateRaw) continue;
    items.push({
      date: dateRaw.slice(0, 10),
      amount: cents,
      type,
      note: ni >= 0 && cols[ni] ? cols[ni] : null,
      externalId: ei >= 0 && cols[ei] ? cols[ei] : null,
    });
  }
  return items;
}
