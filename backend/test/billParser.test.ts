process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlipay, parseBankPdf, parseWechat, parseWechatXlsx, getXlsxQueueState, withXlsxSlot } from "../src/lib/billParser.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const WECHAT_SAMPLE = `微信支付账单明细
微信昵称：测试
起始时间：[2024-01-01 00:00:00] 终止时间：[2024-01-31 23:59:59]
导出时间：[2026-01-01 00:00:00]
---------------------------------微信支付账单明细列表------------------------------------
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2024-01-03 12:30:00,商户消费,某商家,午餐,支出,¥25.00,零钱,支付成功,4200001,,午餐
2024-01-05 09:00:00,转账,某人,转账收入,收入,¥100.50,零钱,支付成功,4200002,,转账
2024-01-07 20:00:00,商户消费,某店,购物,支出,¥88.88,零钱,支付成功,4200003,,购物
2024-01-08 08:00:00,商户消费,某店,已退款,支出,¥10.00,零钱,已全额退款,4200004,,退款
`;

const ALIPAY_SAMPLE = `支付宝交易记录明细查询
账号:[测试] 起始日期:[2024-01-01 00:00:00] 终止日期:[2024-01-31 23:59:59]
交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态
2024010123456789,,2024-01-02 10:00:00,2024-01-02 10:00:05,2024-01-02 10:00:05,网上消费,支付宝,某商家,一杯咖啡,12.00,支出,交易成功,0.00,0.00,,已支出
2024010199999999,,2024-01-04 11:00:00,2024-01-04 11:00:06,2024-01-04 11:00:06,转账,支付宝,某人,还款,200.00,收入,交易成功,0.00,0.00,,已收入
2024010190000000,,2024-01-06 12:00:00,2024-01-06 12:00:06,2024-01-06 12:00:06,网上消费,支付宝,某店,失败订单,30.00,支出,等待付款,0.00,0.00,,未支出
`;

test("解析微信支付明细 txt", () => {
  const items = parseWechat(WECHAT_SAMPLE);
  assert.equal(items.length, 3, "应解析 3 条有效流水（退款那条被跳过）");
  assert.deepEqual(items.map((i) => i.externalId), ["4200001", "4200002", "4200003"]);
  assert.equal(items[0]!.type, "expense");
  assert.equal(items[0]!.amount, 2500);
  assert.equal(items[0]!.date, "2024-01-03");
  assert.equal(items[1]!.type, "income");
  assert.equal(items[1]!.amount, 10050);
  assert.equal(items[2]!.amount, 8888);
});

test("解析支付宝交易明细 csv", () => {
  const items = parseAlipay(ALIPAY_SAMPLE);
  assert.equal(items.length, 2, "应解析 2 条有效流水（等待付款被跳过）");
  assert.equal(items[0]!.type, "expense");
  assert.equal(items[0]!.amount, 1200);
  assert.equal(items[1]!.type, "income");
  assert.equal(items[1]!.amount, 20000);
  assert.equal(items[1]!.externalId, "2024010199999999");
});

test("解析微信支付明细 xlsx（exceljs 安全解析器，含大小/行列限制与错误兜底）", async () => {
  const ExcelJS = require("exceljs");
  const wbook = new ExcelJS.Workbook();
  const wsheet = wbook.addWorksheet("微信支付账单明细");
  wsheet.addRow(["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"]);
  wsheet.addRow(["2024-01-03 12:30:00", "商户消费", "某商家", "午餐", "支出", "¥25.00", "零钱", "支付成功", "4200101", "", "午餐"]);
  wsheet.addRow(["2024-01-05 09:00:00", "转账", "某人", "转账收入", "收入", "¥100.50", "零钱", "支付成功", "4200102", "", "转账"]);
  const buf = (await wbook.xlsx.writeBuffer()) as Uint8Array;

  const items = await parseWechatXlsx(buf);
  assert.equal(items.length, 2, "xlsx 应解析出 2 条");
  assert.deepEqual(items.map((i) => i.externalId), ["4200101", "4200102"]);
  assert.equal(items[0]!.amount, 2500);
  assert.equal(items[1]!.amount, 10050);

  // 超过大小上限：应抛出明确错误（XLSX_TOO_LARGE）
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  await assert.rejects(() => parseWechatXlsx(big), /XLSX_TOO_LARGE|无法解析/);
});

test("xlsx 解析并发数量限制：并发请求全部成功、不互相死锁、不留下永不完成", async () => {
  // 并发数量限制为 4：一次启动 5 个“解析”（使用与 parseWechatXlsx 完全相同的
  // 信号量槽位 withXlsxSlot），前 4 个占满全部槽位，第 5 个必须实际进入等待队列
  // （active=4、queued=1）。
  // 这里用轻量异步代表解析工作，而不是真正生成 5 个原生 worker：Node 24 + macOS
  // 在并行测试下快速创建/销毁多个 worker 会偶发 uv_async_send → SIGABRT（已定位），
  // 而真实单 worker 解析已由本文件的其它用例覆盖，槽位/排队逻辑此处得到确定、无竞态地验证。
  // withXlsxSlot 在同步阶段完成计数：5 个调用全部发起的瞬间即可断言入队。
  const calls = Array.from({ length: 5 }, () =>
    withXlsxSlot(async () => {
      await new Promise((r) => setTimeout(r, 10)); // 模拟解析耗时
      return 42;
    }),
  );
  const midQueue = getXlsxQueueState();
  assert.equal(midQueue.active, 4, "并发前 4 个应占满全部槽位");
  assert.equal(midQueue.queued, 1, "第 5 个解析必须实际进入等待队列");

  const results = await Promise.all(calls);
  const endQueue = getXlsxQueueState();
  assert.equal(endQueue.queued, 0, "全部完成后队列应清空");
  assert.equal(endQueue.active, 0, "全部完成后槽位应全部释放");
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.equal(r, 42, "每个并发解析都应完成");
  }
});

test("xlsx 解析最大返回单元格限制：超过 XLSX_MAX_CELLS 时明确拒绝", async () => {
  const ExcelJS = require("exceljs");
  const wbook = new ExcelJS.Workbook();
  const wsheet = wbook.addWorksheet("超大表");
  // 2000 行 × 256 列 ≈ 512,000 个单元格 > 500,000 上限（且不触发 5MB/100k 行限制）
  for (let i = 0; i < 2000; i++) {
    wsheet.addRow(Array.from({ length: 256 }, (_, c) => `r${i}c${c}`));
  }
  const buf = (await wbook.xlsx.writeBuffer()) as Uint8Array;
  await assert.rejects(() => parseWechatXlsx(buf), /XLSX_TOO_MANY_CELLS|无法解析/);
});

test("银行 PDF 走独立子进程：超过大小上限明确拒绝，不进入解析", async () => {
  // 10MB 上限由宿主在 spawn 之前拦截（不进子进程、不占槽位）
  const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
  await assert.rejects(() => parseBankPdf(tooBig), /PDF_TOO_LARGE/);
});

test("银行 PDF 解析失败/空文件给出可操作错误，且必定结束（不会永久挂起）", async () => {
  // 空字节：子进程应回报失败而不是让 Promise 永不完成
  await assert.rejects(() => parseBankPdf(new Uint8Array(0)), /PDF_PARSE_FAILED|无法解析/);
  // 非 PDF 内容：同样必须失败并返回
  await assert.rejects(() => parseBankPdf(new TextEncoder().encode("not a pdf at all")), /PDF_PARSE_FAILED|无法解析/);
});

// 回归：微信/银行导出的 xlsx 里「交易时间」是**真实的 Excel 日期单元格**（不是字符串），
// exceljs 会把它还原成 Date，而 Date → String 是 "Tue Aug 18 2026 12:30:00 GMT+0800 (…)"，
// 解析层再 slice(0,10) 就写成了 "Tue Aug 18" —— 线上真实故障：
// 391 条微信流水的日期变成不可解析的文本，字符串比较下它们排在所有 "2026-…" 之后，
// 于是被排除在**每一个**按月区间之外（在 App 里完全看不见）。
test("xlsx 的 Excel 日期单元格被归一为 YYYY-MM-DD（线上 391 条坏日期的根因）", async () => {
  const ExcelJS = require("exceljs");
  const wbook = new ExcelJS.Workbook();
  const wsheet = wbook.addWorksheet("明细");
  wsheet.addRow(["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"]);
  const rowsData: Array<[Date, string]> = [
    [new Date(Date.UTC(2026, 7, 18, 12, 30, 0)), "4200201"], // 2026-08-18（周二）
    [new Date(Date.UTC(2026, 4, 20, 9, 5, 0)), "4200202"],  // 2026-05-20（周三）
  ];
  for (const [date, orderNo] of rowsData) {
    const row = wsheet.addRow([date, "商户消费", "某商家", "午餐", "支出", "¥25.00", "零钱", "支付成功", orderNo, "", "午餐"]);
    // 明确写成「日期类型 + 日期格式」的单元格，模拟微信导出的真实单元格类型
    row.getCell(1).value = date;
    row.getCell(1).numFmt = "yyyy-mm-dd hh:mm:ss";
  }
  const buf = (await wbook.xlsx.writeBuffer()) as Uint8Array;

  const items = await parseWechatXlsx(buf);
  assert.equal(items.length, 2, "两笔都应解析出来");
  for (const it of items) {
    assert.match(it.date, /^\d{4}-\d{2}-\d{2}$/, `日期必须是 YYYY-MM-DD，实际 ${JSON.stringify(it.date)}`);
  }
  assert.deepEqual(
    items.map((i) => i.date).sort(),
    ["2026-05-20", "2026-08-18"],
    "Excel 日期单元格必须按墙钟值还原（不随进程时区漂移）",
  );
});

test("日期归一：常见写法统一成 ISO，无法解析时返回 null", async () => {
  const { normalizeBillDate } = await import("../src/lib/billParser.js");
  assert.equal(normalizeBillDate("2026-08-18 12:30:00"), "2026-08-18");
  assert.equal(normalizeBillDate("2026/8/5"), "2026-08-05");
  assert.equal(normalizeBillDate("2026.8.5 09:00"), "2026-08-05");
  assert.equal(normalizeBillDate("  2026-08-18T12:30:00Z  "), "2026-08-18");
  assert.equal(normalizeBillDate(""), null);
  assert.equal(normalizeBillDate("Tue Aug 18"), null, "Weekday 文本是不可解析的（正是线上坏数据）");
  assert.equal(normalizeBillDate("2026-02-31"), null, "不存在的日历日必须拒绝（regex 挡不住）");
});

test("数据行日期无法解析时整份文件报错，而不是静默丢行或写脏数据", async () => {
  // 微信：收/支 + 金额都合法 → 这就是一笔真实流水，日期不可解析必须可见地失败
  const wechat = `微信支付账单明细
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
Tue Aug 18,商户消费,某商家,午餐,支出,¥25.00,零钱,支付成功,4200301,,午餐
`;
  assert.throws(
    () => parseWechat(wechat),
    /BILL_DATE_UNPARSABLE|日期无法解析/,
    "不可解析的日期必须报错（历史行为是 slice(0,10) 原样落库）",
  );

  // 支付宝同理
  const alipay = `交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额,收/支,交易状态
20260101001,,Tue Aug 18 12:30:00,2026-08-18 12:30:05,2026-08-18 12:30:05,其他,即时到账,某商家,午餐,25.00,支出,交易成功
`;
  assert.throws(() => parseAlipay(alipay), /日期无法解析/);
});

test("银行 CSV：表头/合计等非数据行照旧跳过，只有真实流水行才因日期报错", async () => {
  const { parseBillFile } = await import("../src/lib/billFile.js");
  const csv = [
    "记账日期,交易金额,余额,摘要,对方户名,币种",
    "2026-08-18,25.00,1000.00,消费,某商家,人民币",
    "本页合计,,,",
    "2026-08-19,30.00,970.00,消费,另一商家,人民币",
  ].join("\n");
  const parsed = await parseBillFile(Buffer.from(csv, "utf8"), "bank.csv", "auto");
  assert.equal(parsed.items.length, 2, "合计行没有金额，应被当作非数据行跳过");
  assert.deepEqual(parsed.items.map((i) => i.date), ["2026-08-18", "2026-08-19"]);

  const bad = [
    "记账日期,交易金额,余额,摘要,对方户名,币种",
    "Wed May 20,25.00,1000.00,消费,某商家,人民币",
  ].join("\n");
  await assert.rejects(
    () => parseBillFile(Buffer.from(bad, "utf8"), "bank.csv", "auto"),
    /日期无法解析/,
    "银行流水的日期不可解析时也必须报错",
  );
});
