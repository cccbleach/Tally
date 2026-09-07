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
export function parseWechatRows(rows: string[][]): ParsedBill[] {
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
  return parseWechatRows(parseTextRows(text));
}

export function parseTextRows(text: string): string[][] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).map(splitCsvLine);
}

// xlsx 解析：在独立 worker 线程中以受限内存/超时解析（改用安全解析器 exceljs，
// 替代有高危漏洞且 npm 无修复版本的 SheetJS/xlsx）。
// 这样恶意/畸形 xlsx 即使尝试解压超大或过度构造内容，也不会耗尽服务主线程资源。
// 注意：worker 线程不是进程级硬隔离（见 xlsxWorker.cts 头部说明）。
const XLSX_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB（上传层另有 20MB 总量限制）
const XLSX_WORKER_TIMEOUT_MS = 20_000;      // worker 超时上限
const XLSX_MAX_CONCURRENCY = 4;             // 同时最多允许的解析 worker 数（并发数量限制）

// 并发信号量：防止大量并发上传同时各起一个 worker，把 CPU/内存瞬时打满。
// 采用原子“槽位移交”模型：有等待者时，释放方直接把当前槽位交给队首等待者（next()），
// 而不是先 xlsxActive-- 再由等待者 xlsxActive++ —— 后者两步之间会出现瞬时空闲
// （active 少 1），可能让新请求误以为有空位而超额并发。槽位移交保持 active 计数不变，
// 只有无等待者时才真正回收槽位。
let xlsxActive = 0;
const xlsxQueue: Array<() => void> = [];
async function acquireXlsxSlot(): Promise<void> {
  if (xlsxActive < XLSX_MAX_CONCURRENCY) {
    xlsxActive++;
    return;
  }
  await new Promise<void>((resolve) => xlsxQueue.push(resolve));
  // 被唤醒即代表已持有槽位：active 计数由释放方在移交时保持不变，无需再增减。
}
function releaseXlsxSlot(): void {
  const next = xlsxQueue.shift();
  if (next) {
    next(); // 直接把当前槽位移交给队首等待者，active 计数保持不变（避免瞬时超额）
  } else {
    xlsxActive--;
  }
}

// 在信号量槽位内执行异步工作（parseWechatXlsx 与并发测试共用同一套槽位逻辑）。
export async function withXlsxSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireXlsxSlot();
  try {
    return await work();
  } finally {
    releaseXlsxSlot();
  }
}

// 仅供测试观测并发队列状态，不做任何业务逻辑。
export function getXlsxQueueState(): { active: number; queued: number } {
  return { active: xlsxActive, queued: xlsxQueue.length };
}

// 微信支付明细 xlsx（微信“导出账单”实际生成的是 xlsx）
export async function parseWechatXlsx(buf: Uint8Array): Promise<ParsedBill[]> {
  return parseWechatRows(await readXlsxRows(buf));
}

// 同一受限 worker 读取表格，再按表头识别来源；不在主线程重复解压。
export async function readXlsxRows(buf: Uint8Array): Promise<string[][]> {
  if (buf.byteLength > XLSX_MAX_FILE_SIZE) {
    throw new Error("XLSX_TOO_LARGE: 微信 xlsx 账单超过 5MB 上限");
  }
  return withXlsxSlot(async () => {
    const { Worker } = await import("node:worker_threads");
    const worker = new Worker(new URL("./xlsxWorker.cjs", import.meta.url), {
      workerData: { buf },
      // 内存限制：限制 worker 旧代堆到 64MB、新生代到 16MB（非进程级硬隔离）
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      // xlsx worker 是纯 CommonJS（.cjs），不需要 TypeScript 转换或 ESM loader：
      // 明确清空 execArgv，避免继承测试/开发环境（tsx）注入的 --import loader；
      // 否则 Node 在 worker 内走 ESM loader 的 getSourceSync 读取入口文件时会把
      // fd 标成 “unmanaged mode”，产生 “File descriptor ... opened/closed in
      // unmanaged mode” 批量告警（Node 24 + tsx 已知现象，生产 dist 纯 node 无此告警）。
      execArgv: [],
    });

    return await new Promise<string[][]>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(msg));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        reject(new Error("XLSX_TIMEOUT: xlsx 解析超时"));
      }, XLSX_WORKER_TIMEOUT_MS);

      worker.once("message", (msg: { ok: boolean; rows?: string[][]; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 成功路径不强制 terminate：worker 在 postMessage 后事件循环自然清空即自行退出
        // （已实测）。强行 terminate 会在快速 生成/销毁 并发 worker 时与 Node 内部
        // MessagePort 拆除竞态，触发 uv_async_send → SIGABRT（macOS 并行测试崩源）。
        if (msg.ok) {
          try {
            resolve((msg.rows ?? []).map((r) => r ?? []));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`${msg.error ?? "XLSX_PARSE_FAILED"}: 无法解析该 Excel 文件，请确认是微信导出格式`));
        }
      });
      worker.once("error", (e: Error) => {
        fail("XLSX_PARSE_FAILED: 无法解析该 Excel 文件，请确认是微信导出格式");
      });
      worker.once("exit", (code: number) => {
        // 若在收到 message/error 之前 worker 就退出（无论退出码 0/非 0），
        // 都必须 reject，绝不留下永不完成的 Promise。
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("XLSX_PARSE_FAILED: 无法解析该 Excel 文件，请确认是微信导出格式"));
        }
      });
    });
  });
}

// 支付宝交易明细 csv
export function parseAlipay(text: string): ParsedBill[] {
  return parseAlipayRows(parseTextRows(text));
}

export function parseAlipayRows(rows: string[][]): ParsedBill[] {
  const headerIdx = rows.findIndex((r) => r.some((h) => h.includes("金额")) && r.some((h) => h.includes("收/支")));
  if (headerIdx < 0) return [];
  const headers = rows[headerIdx]!;
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
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cols = rows[i]!;
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
  // pdf.js 不接受 Node Buffer；必须复制成普通 Uint8Array。
  const parser = new PDFParse({ data: new Uint8Array(buf) });
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
