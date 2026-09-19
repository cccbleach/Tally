import { badRequest } from "./errors.js";
import {
  assertBillCurrencyCny, decodeBillBuffer, normalizeBillDate, parseAlipayRows, parseBankPdf,
  parseTextRows, parseWechatRows, readXlsxRows, type ParsedBill,
} from "./billParser.js";

export type BillSource = "wechat" | "alipay" | "bank";
export const BILL_FILE_MAX_BYTES = 20 * 1024 * 1024;

const bankDateHeaders = ["记账日期", "交易日期"];
const bankAmountHeaders = ["交易金额", "发生额"];
const bankBalanceHeaders = ["余额", "联机余额", "账户余额"];
const hasAny = (row: string[], names: string[]) => row.some((value) => names.includes(value.trim()));

function isBankHeader(row: string[]): boolean {
  return hasAny(row, bankDateHeaders) && hasAny(row, bankAmountHeaders) && hasAny(row, bankBalanceHeaders);
}

function detectSource(rows: string[][]): BillSource | null {
  // 只看同一行的结构化表头，不依赖文件名或商户备注中的“微信/支付宝”字样。
  for (const row of rows) {
    if (row.includes("收/支") && row.some((h) => h.includes("金额"))) {
      if (row.includes("交易单号") && row.includes("当前状态")) return "wechat";
      if (hasAny(row, ["交易号", "交易订单号"]) && row.includes("交易状态")) return "alipay";
    }
    if (isBankHeader(row)) return "bank";
  }
  return null;
}

function parseBankRows(rows: string[][]): ParsedBill[] {
  const headerIndex = rows.findIndex(isBankHeader);
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex]!.map((value) => value.trim());
  const col = (names: string[]) => headers.findIndex((value) => names.includes(value));
  const di = col(bankDateHeaders), ai = col(bankAmountHeaders);
  const ci = col(["币种", "货币"]), ti = col(["收/支", "收支", "借贷标志"]);
  const ni = col(["交易摘要", "摘要", "备注"]), pi = col(["对手信息", "对方户名", "交易对手"]);
  const ei = col(["流水号", "交易流水号"]);
  const items: ParsedBill[] = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const amount = Number((row[ai] ?? "").replace(/[¥￥,\s]/g, ""));
    // 先判断「是不是一笔真实流水」：金额合法才算数据行，表头/合计/空行在这里被跳过
    if (!Number.isFinite(amount) || amount === 0) continue;
    const date = normalizeBillDate(row[di]);
    if (!date) {
      throw badRequest(
        "BILL_DATE_UNPARSABLE",
        `第 ${i + 1} 行日期无法解析（"${(row[di] ?? "").slice(0, 24)}"）：请确认是银行导出的原始交易明细`,
      );
    }
    // 币种列只在是人民币时放行；外币直接报错（历史实现会静默跳过整行，等于悄悄丢数据）
    assertBillCurrencyCny(row[ci], `第 ${i + 1} 行`);
    const direction = row[ti] ?? "";
    const type = ["支出", "借", "借方"].includes(direction) ? "expense"
      : ["收入", "贷", "贷方"].includes(direction) ? "income"
      : amount < 0 ? "expense" : "income";
    const cents = Math.round(Math.abs(amount) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) continue;
    const note = [row[ni], row[pi]].filter(Boolean).join(" ").trim();
    // external_id 的币种位置固定写 "CNY"（历史格式保留字面量）：人民币账单的存量 external_id
    // 就是这一形态，换掉字面量会让重新导入同一份账单绕过硬去重产生重复流水。
    items.push({ date, amount: cents, type, note: note || null,
      externalId: row[ei] || `bank:${date}:CNY:${type}:${cents}:${note}` });
  }
  return items;
}

export async function parseBillFile(
  buf: Buffer, filename: string, requestedSource?: BillSource | "auto",
): Promise<{ source: BillSource; items: ParsedBill[] }> {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "zip") throw badRequest("FILE_NEEDS_UNZIP", "请先在“文件”App 中解压账单，再选择里面的 CSV、TXT、XLSX 或 PDF 文件");
  if (!["txt", "csv", "xlsx", "pdf"].includes(extension ?? "")) {
    throw badRequest("FILE_EXT_NOT_ALLOWED", "仅支持 TXT、CSV、XLSX 或 PDF 账单文件");
  }
  if (buf.length === 0) throw badRequest("FILE_EMPTY", "文件为空，请重新导出账单");
  if (buf.length > BILL_FILE_MAX_BYTES || (extension === "xlsx" && buf.length > 5 * 1024 * 1024)) {
    throw badRequest("FILE_TOO_LARGE", extension === "xlsx" ? "Excel 账单不能超过 5MB，请缩短导出时间范围" : "账单文件不能超过 20MB");
  }

  let source: BillSource;
  let items: ParsedBill[];
  if (extension === "pdf") {
    if (!buf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw badRequest("PARSE_FAILED", "文件不是有效 PDF，请重新导出");
    source = "bank";
    try {
      items = await parseBankPdf(buf);
    } catch (error) {
      if (error instanceof Error && /password/i.test(error.name + error.message)) {
        throw badRequest("PDF_PASSWORD_REQUIRED", "此 PDF 已加密，请先解密后上传");
      }
      throw badRequest("PARSE_FAILED", "无法读取 PDF，请上传银行导出的文字版交易流水");
    }
  } else {
    let rows: string[][];
    if (extension === "xlsx") {
      try {
        rows = await readXlsxRows(buf);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/XLSX_TOO_MANY_ROWS|XLSX_TOO_MANY_CELLS/.test(message)) {
          throw badRequest("TOO_MANY_ITEMS", "Excel 账单内容过多，请缩短导出时间范围");
        }
        throw badRequest("PARSE_FAILED", "无法读取 Excel，请选择解压后、未加密的 XLSX 账单");
      }
    } else {
      rows = parseTextRows(decodeBillBuffer(buf));
    }
    const detected = detectSource(rows);
    if (!detected) throw badRequest("BILL_FORMAT_UNRECOGNIZED", "未识别到账单表头，请选择微信、支付宝或银行导出的原始交易明细文件");
    source = detected;
    items = source === "wechat" ? parseWechatRows(rows) : source === "alipay" ? parseAlipayRows(rows) : parseBankRows(rows);
  }
  if (requestedSource && requestedSource !== "auto" && requestedSource !== source) {
    throw badRequest("BILL_SOURCE_MISMATCH", "文件内容与选择的来源不一致，请使用自动识别导入");
  }
  if (!items.length) throw badRequest("EMPTY_BILL", source === "bank"
    ? "未解析到银行流水。目前支持包含日期、币种、交易金额、余额的文字 PDF，或带标准表头的 CSV/XLSX；扫描件暂不支持"
    : "账单中没有可导入的成功收支记录，请检查导出时间范围");
  if (items.length > 5000) throw badRequest("TOO_MANY_ITEMS", "单次最多导入 5000 条，请缩短导出时间范围");
  return { source, items };
}
