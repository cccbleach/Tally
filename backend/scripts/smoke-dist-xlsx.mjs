// 生产 dist 路径 Excel 解析 smoke test。
// 验证：在 tsc 编译后的 dist 产物中（dist/lib/billParser.js + dist/lib/xlsxWorker.cjs），
// 微信支付明细 xlsx 解析仍能工作（worker 相对路径 ./xlsxWorker.cjs 在 dist 下可解析）。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, "..");

// 显式从 dist 编译产物导入，模拟生产部署路径
const billParser = await import(join(backendRoot, "dist/lib/billParser.js"));
const ExcelJS = require("exceljs");

// 构造一份最小微信 xlsx
const wbook = new ExcelJS.Workbook();
const wsheet = wbook.addWorksheet("微信支付账单明细");
wsheet.addRow(["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"]);
wsheet.addRow(["2024-01-03 12:30:00", "商户消费", "某商家", "午餐", "支出", "¥25.00", "零钱", "支付成功", "4200301", "", "午餐"]);
const buf = await wbook.xlsx.writeBuffer();

const items = await billParser.parseWechatXlsx(buf);
if (!Array.isArray(items) || items.length !== 1 || items[0].externalId !== "4200301") {
  throw new Error("dist 路径 xlsx 解析结果不符合预期: " + JSON.stringify(items));
}
console.log("OK 生产 dist 路径 Excel 解析 smoke test 通过，解析到", items.length, "条");
