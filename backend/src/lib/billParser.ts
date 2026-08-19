// 账单导入解析：支持微信支付明细（txt/xlsx）与支付宝交易明细（csv）。
// 按常见导出格式解析；行结构与网银/银行 App 导出的 CSV 大同小异，后续可扩展 source。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface ParsedBill {
  date: string; // YYYY-MM-DD
  amount: number; // 分（正数）
  type: "income" | "expense";
  note: string | null;
  externalId: string | null; // 来源流水号，用于去重
  currency?: string;
}

// 识别账单文件编码：优先 UTF-8，若出现替换字符则尝试 GBK（微信/支付宝导出常见编码）
export function decodeBillBuffer(buf: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return utf8;
  }
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

// 微信支付明细通用行解析（txt 和 xlsx 共用）
function parseWechatRows(rows: string[][]): ParsedBill[] {
  const headerIdx = rows.findIndex(
    (r) => r.some((h) => h.includes("交易时间")) && r.some((h) => h.includes("金额")),
  );
  if (headerIdx < 0) return [];
  const headers = (rows[headerIdx] ?? []).map((h) => h ?? "");
  const col = (name: string): number => headers.findIndex((h) => h.includes(name));

  const di = col("交易时间");
  const ti = col("收/支");
  const ai = col("金额");
  const ni = col("商品") >= 0 ? col("商品") : col("备注");
  const ei = col("交易单号") >= 0 ? col("交易单号") : col("商户单号");
  const si = col("当前状态");

  const items: ParsedBill[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((c) => !c)) continue;
    const cols = row.map((c) => c ?? "");
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

// 微信支付明细 txt
export function parseWechat(text: string): ParsedBill[] {
  const lines = text.split(/\r?\n/);
  const rows = lines.map((l) => splitCsvLine(l));
  return parseWechatRows(rows);
}

// 微信支付明细 xlsx（微信“导出账单”实际生成的是 xlsx）
export function parseWechatXlsx(buf: Uint8Array): ParsedBill[] {
  const XLSX: any = require("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as unknown[][];
  return parseWechatRows(rows.map((r) => r.map((c) => String(c ?? ""))));
}

// 支付宝交易明细 csv
export function parseAlipay(text: string): ParsedBill[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.includes("金额") && l.includes("收/支"));
  if (headerIdx < 0) return [];
  const headers = splitCsvLine(lines[headerIdx]!);
  const col = (name: string): number => headers.findIndex((h) => h.includes(name));

  const diRaw =
    col("交易创建时间") >= 0
      ? col("交易创建时间")
      : col("付款时间") >= 0
        ? col("付款时间")
        : col("交易时间") >= 0
          ? col("交易时间")
          : -1;
  const ti = col("收/支");
  const ai = col("金额");
  const ni = col("商品名称") >= 0 ? col("商品名称") : col("商品说明") >= 0 ? col("商品说明") : col("备注");
  const ei = col("交易号") >= 0 ? col("交易号") : col("交易订单号") >= 0 ? col("交易订单号") : -1;
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

// 招商银行等交易流水 PDF（按“记账日期 币种 交易金额 联机余额 交易摘要 对手信息”行解析）
export async function parseBankPdf(buf: Uint8Array): Promise<ParsedBill[]> {
  const { PDFParse } = require("pdf-parse") as {
    PDFParse: new (opt: { data: Uint8Array }) => { getText(): Promise<{ text: string }>; destroy(): Promise<void> };
  };
  const parser = new PDFParse({ data: buf });
  let text = "";
  try {
    const result = await parser.getText();
    text = result.text ?? "";
  } finally {
    await parser.destroy();
  }

  const lineRe = /^(\d{4}-\d{2}-\d{2})\s+([A-Z]{3})\s+(-?[\d,]+\.\d{2})\s+[\d,]+\.\d{2}\s+(.+)$/;
  const items: ParsedBill[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = lineRe.exec(line);
    if (!m) continue;
    const date = m[1]!;
    const currency = m[2]!;
    const amountNum = Number(m[3]!.replace(/,/g, ""));
    if (!Number.isFinite(amountNum) || amountNum === 0) continue;
    const type: ParsedBill["type"] = amountNum > 0 ? "income" : "expense";
    const cents = Math.round(Math.abs(amountNum) * 100);
    const rest = m[4]!.trim();
    // 用“日期+币种+金额+摘要”生成确定 externalId，保证同一份 PDF 重复导入不重复
    const externalId = `bank:${date}:${currency}:${cents}:${rest}`;
    items.push({
      date,
      amount: cents,
      type,
      note: rest,
      externalId,
      currency,
    });
  }
  return items;
}
