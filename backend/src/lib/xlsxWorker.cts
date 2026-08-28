// xlsx 解析专用 worker：在独立线程中解析 Excel，并受主进程设置的
// 内存（resourceLimits）与超时（主线程 terminate）限制约束。
// 本 worker 只在 parseWechatXlsx 的隔离调用中运行，避免恶意/畸形 xlsx
// 在服务主线程中耗尽内存或长时间占用事件循环。
//
// 注意：worker 线程不是进程级硬隔离。它与主进程共享同一地址空间与文件描述符表，
// 仅提供独立的 V8 堆/事件循环与独立崩溃边界；真正“进程级”硬隔离需要 child_process。
// 这里通过 resourceLimits（主进程设置）+ 输入大小/行/单元格上限 + 超时 terminate
// 尽量收窄影响范围。
//
// 本文件采用 CommonJS（.cts → 编译为 .cjs）而非 ESM：Node 24 中 worker 线程以 ESM
// 加载模块时，其 ESM loader（getSourceSync）会在与主进程共享的文件描述符表上触发
// “File descriptor ... opened/closed in unmanaged mode” 警告（dist smoke 可复现）。
// CJS worker 走 CJS loader，可完全消除该警告，功能与限制完全一致。

import { parentPort, workerData } from "node:worker_threads";
// CJS 形式加载 exceljs（worker 内不走 ESM loader，避免 unmanaged fd 警告）
const ExcelJS = require("exceljs") as typeof import("exceljs");

const XLSX_MAX_FILE_SIZE = 5 * 1024 * 1024;
const XLSX_MAX_ROWS = 100_000;
const XLSX_MAX_COLS = 256;
const XLSX_MAX_CELLS = 500_000; // 返回单元格总数上限（含被截断列），防止返回天文数字单元格

interface Payload {
  buf: Uint8Array;
}

async function run() {
  try {
    const { buf } = workerData as Payload;
    if (buf.byteLength > XLSX_MAX_FILE_SIZE) {
      throw new Error("XLSX_TOO_LARGE");
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("XLSX_EMPTY");
    if (ws.rowCount > XLSX_MAX_ROWS) throw new Error("XLSX_TOO_MANY_ROWS");
    const rows: string[][] = [];
    let cellCount = 0;
    await ws.eachRow({ includeEmpty: false }, (row: any) => {
      if (rows.length >= XLSX_MAX_ROWS) return;
      const vals = Array.isArray(row?.values) ? (row.values as unknown[]).slice(1) : [];
      const capped = vals.slice(0, XLSX_MAX_COLS);
      cellCount += capped.length;
      if (cellCount > XLSX_MAX_CELLS) {
        throw new Error("XLSX_TOO_MANY_CELLS");
      }
      rows.push(capped.map((c) => String(c ?? "")));
    });
    // 最终再校验一次返回单元格总数（覆盖稀疏/空行累计误差）
    const totalCells = rows.reduce((sum, r) => sum + r.length, 0);
    if (totalCells > XLSX_MAX_CELLS) {
      throw new Error("XLSX_TOO_MANY_CELLS");
    }
    parentPort!.postMessage({ ok: true, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    parentPort!.postMessage({ ok: false, error: /^(XLSX_|工作表)/.test(msg) ? msg : "XLSX_PARSE_FAILED" });
  }
}

void run();
