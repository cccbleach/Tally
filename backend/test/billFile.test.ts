process.env.ALIYUN_SMS_ENABLED = "false";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBillFile, BILL_FILE_MAX_BYTES } from "../src/lib/billFile.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { smsRegister, authHeaders } from "./helpers.js";
import type { FastifyInstance } from "fastify";
const require = createRequire(import.meta.url);

const wechat = "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注\n2024-01-03 12:30:00,商户消费,商家,午餐,支出,¥25.00,零钱,支付成功,wx-auto-1,,\n";
const alipay = "交易号,商家订单号,交易创建时间,付款时间,商品名称,金额（元）,收/支,交易状态\nali-auto-1,,2024-01-02 10:00:00,,咖啡,12.00,支出,交易成功\n";
const bank = "记账日期,币种,交易金额,联机余额,交易摘要,对手信息\n2024-01-03,CNY,-25.00,975.00,消费,午餐商店\n2024-01-04,CNY,100.00,1075.00,入账,朋友\n";

function bankPdf(): Buffer {
  const stream = "BT /F1 12 Tf 36 760 Td (2024-01-03 CNY -25.00 975.00 Lunch) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("统一导入：同一个无来源入口按表头识别微信、支付宝、银行 CSV", async () => {
  for (const [text, source, amount] of [[wechat, "wechat", 2500], [alipay, "alipay", 1200], [bank, "bank", 2500]] as const) {
    const result = await parseBillFile(Buffer.from("\uFEFF" + text), "同一个入口.CSV");
    assert.equal(result.source, source);
    assert.equal(result.items[0]!.amount, amount);
    assert.equal(result.items[0]!.type, "expense");
  }
  const result = await parseBillFile(Buffer.from(bank), "银行.csv");
  assert.equal(result.items[1]!.type, "income");
});

test("统一导入：Excel 共用受限 worker，按表头区分三种来源", async () => {
  const ExcelJS = require("exceljs");
  for (const [text, source] of [[wechat, "wechat"], [alipay, "alipay"], [bank, "bank"]] as const) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("账单");
    for (const row of text.trim().split("\n")) sheet.addRow(row.split(","));
    const result = await parseBillFile(Buffer.from(await workbook.xlsx.writeBuffer()), "账单.xlsx", "auto");
    assert.equal(result.source, source);
    assert.ok(result.items.length > 0);
  }
});

test("银行 PDF：接收真实上传的 Node Buffer，不触发 pdf.js Buffer 类型错误", async () => {
  const result = await parseBillFile(bankPdf(), "账单.pdf");
  assert.equal(result.source, "bank");
  assert.deepEqual(result.items.map(({ date, amount, type }) => ({ date, amount, type })), [
    { date: "2024-01-03", amount: 2500, type: "expense" },
  ]);
});

test("文件来源由内容决定；未知表头、来源不匹配、压缩包和坏 PDF 给出可操作错误", async () => {
  assert.equal((await parseBillFile(Buffer.from(alipay), "微信银行.csv")).source, "alipay");
  await assert.rejects(parseBillFile(Buffer.from(alipay), "账单.csv", "wechat"), { code: "BILL_SOURCE_MISMATCH" });
  await assert.rejects(parseBillFile(Buffer.from("微信支付宝银行\nfoo,bar\n1,2"), "账单.csv"), { code: "BILL_FORMAT_UNRECOGNIZED" });
  await assert.rejects(parseBillFile(Buffer.from("PK"), "账单.zip"), { code: "FILE_NEEDS_UNZIP" });
  await assert.rejects(parseBillFile(Buffer.from("not a pdf"), "账单.pdf"), { code: "PARSE_FAILED" });
  await assert.rejects(parseBillFile(Buffer.from("%PDF-broken"), "账单.pdf"), { code: "PARSE_FAILED" });
});

test("统一入口仍执行空文件、大小与成功流水限制", async () => {
  await assert.rejects(parseBillFile(Buffer.alloc(0), "账单.csv"), { code: "FILE_EMPTY" });
  await assert.rejects(parseBillFile(Buffer.alloc(5 * 1024 * 1024 + 1), "账单.xlsx"), { code: "FILE_TOO_LARGE" });
  await assert.rejects(parseBillFile(Buffer.alloc(BILL_FILE_MAX_BYTES + 1), "账单.csv"), { code: "FILE_TOO_LARGE" });
  await assert.rejects(parseBillFile(Buffer.from(wechat.replace("支付成功", "已全额退款")), "账单.csv"), { code: "EMPTY_BILL" });
});

let app: FastifyInstance;
let sqlite: ReturnType<typeof createDb>["sqlite"];
let headers: Record<string, string>;
let noAccountHeaders: Record<string, string>;
let dir: string;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-unified-import-"));
  const created = createDb(join(dir, "test.db"));
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db: created.db, jwtSecret: "test-import-secret" });
  headers = authHeaders(await smsRegister(app, "13841000001", "统一导入测试"));
  noAccountHeaders = authHeaders(await smsRegister(app, "13841000002", "无账户测试"));
  const account = await app.inject({ method: "POST", url: "/api/v1/accounts", headers, payload: { name: "储蓄卡", type: "bank" } });
  assert.equal(account.statusCode, 200, account.body);
});
after(async () => { await app.close(); sqlite.close(); rmSync(dir, { recursive: true, force: true }); });

function upload(contents: Buffer, filename: string, source?: string, authorization = headers) {
  const boundary = "UnifiedImportBoundary";
  const field = source ? `--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\n${source}\r\n` : "";
  const payload = Buffer.concat([
    Buffer.from(`${field}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    contents, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: "/api/v1/imports/jobs/upload", headers: { ...authorization, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
}

test("真实 multipart 无 source：返回识别来源并仅暂存，不直接入账", async () => {
  for (const [contents, name, source] of [[Buffer.from(wechat), "wx.csv", "wechat"], [Buffer.from(alipay), "ali.csv", "alipay"], [bankPdf(), "bank.pdf", "bank"]] as const) {
    const response = await upload(contents, name);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().item.source, source);
    assert.equal(response.json().item.status, "staged");
  }
  assert.equal(sqlite.prepare("SELECT count(*) n FROM transactions").get()!.n, 0);
});

test("原客户端显式 source 仍可用，未知 source 不静默降级", async () => {
  assert.equal((await upload(Buffer.from(wechat), "wx.txt", "wechat")).statusCode, 200);
  const invalid = await upload(Buffer.from(wechat), "wx.txt", "unknown");
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION");
});

test("无账户时明确提示，不创建半成品导入任务", async () => {
  const before = sqlite.prepare("SELECT count(*) n FROM import_jobs").get()!.n;
  const response = await upload(Buffer.from(wechat), "wx.csv", undefined, noAccountHeaders);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "ACCOUNT_REQUIRED");
  assert.equal(sqlite.prepare("SELECT count(*) n FROM import_jobs").get()!.n, before);
});

test("multipart 超过插件大小上限返回 413 FILE_TOO_LARGE，不伪装成服务器内部错误", async () => {
  const response = await upload(Buffer.alloc(BILL_FILE_MAX_BYTES + 1, 65), "too-big.csv");
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, "FILE_TOO_LARGE");
});
