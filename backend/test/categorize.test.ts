process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestCategoryId, type CategoryOption } from "../src/lib/categorize.js";

// 关键词自动分类回归。背景：导入曾把全部流水挂到「账本第一个支出分类」
// （生产 1546 笔支出全是餐饮），统计完全失真。这里钉死分类器的行为：
//   1) 关键词命中 → 对应分类 id；
//   2) 支出未命中 → null（未分类），绝不硬塞第一个分类；
//   3) 收入未命中 → 回退「其他收入」；
//   4) 账本里没有规则要求的分类时跳过该规则（分类可自定义）。

const cats: CategoryOption[] = [
  { id: "c-canyin", name: "餐饮", type: "expense" },
  { id: "c-jiaotong", name: "交通", type: "expense" },
  { id: "c-gouwu", name: "购物", type: "expense" },
  { id: "c-juzhu", name: "居住", type: "expense" },
  { id: "c-yiliao", name: "医疗", type: "expense" },
  { id: "c-yule", name: "娱乐", type: "expense" },
  { id: "c-jiaoyu", name: "教育", type: "expense" },
  { id: "c-renqing", name: "人情", type: "expense" },
  { id: "c-qita", name: "其他支出", type: "expense" },
  { id: "c-gongzi", name: "工资", type: "income" },
  { id: "c-licai", name: "理财", type: "income" },
  { id: "c-qitashouru", name: "其他收入", type: "income" },
];

test("支出：关键词命中对应分类（生产备注的真实样例）", () => {
  const cases: Array<[string, string]> = [
    ["浙江大学医学院附属妇产科医院-消费", "c-yiliao"],
    ["银联快捷支付 浙江大学医学院附属妇产科医院", "c-yiliao"],
    ["火车票", "c-jiaotong"],
    ["ETC通行费代扣", "c-jiaotong"],
    ["滴滴专车打车-许师傅-行程", "c-jiaotong"],
    ["快捷支付 疯狂的主人京东自营旗舰店", "c-gouwu"],
    ["山姆自助购", "c-gouwu"],
    ["银联无卡自助消费 （特约）美团", "c-canyin"],
    ["Meituan-赠李白 · 如诗的川味（亲橙里店）", "c-canyin"],
    ["智能货柜消费_可口可乐零度无糖汽水330ml_消费时间:2026-02-28", "c-canyin"],
    ["盒马 葱姜蒜组合净菜 50g等3类商品", "c-canyin"],
    ["酒店", "c-juzhu"],
    ["游廊地图RPG", "c-yule"],
    ["商保系统保单付款", "c-qita"],
    ["转账汇款 牛亚凡", "c-qita"],
    ["结售汇即时售汇 彭冲 （原 HKD 5000.00，已按 1 HKD = 0.92 CNY 折算）", "c-qita"],
    ["柜台取现", "c-qita"],
    ["Bandwagon Host Compute Cloud - Invoice 230", "c-qita"],
    ["海底捞(杭州三十五店)", "c-canyin"],
    ["火山引擎订单", "c-qita"],
    ["腾讯云购买云服务-100051991014", "c-qita"],
  ];
  for (const [note, expected] of cases) {
    assert.equal(suggestCategoryId(note, cats, "expense"), expected, note);
  }
});

test("支出：无法识别的备注返回 null（未分类），不再硬塞第一个分类", () => {
  assert.equal(suggestCategoryId("58260129342520@9245", cats, "expense"), null);
  assert.equal(suggestCategoryId("", cats, "expense"), null);
  assert.equal(suggestCategoryId(null, cats, "expense"), null);
});

test("收入：工资/理财命中，其余回退其他收入", () => {
  assert.equal(suggestCategoryId("代发工资 浙江天猫技术有限公司", cats, "income"), "c-gongzi");
  assert.equal(suggestCategoryId("余额宝收益", cats, "income"), "c-licai");
  assert.equal(suggestCategoryId("客户扫码付款", cats, "income"), "c-qitashouru");
});

test("账本里没有规则要求的分类时返回 null 而不是别的分类", () => {
  const partial: CategoryOption[] = [
    { id: "c-1", name: "餐饮", type: "expense" },
    { id: "c-2", name: "工资", type: "income" },
  ];
  // 医院备注想归「医疗」，但账本没有该分类 → 不硬塞餐饮
  assert.equal(suggestCategoryId("妇产科医院-消费", partial, "expense"), null);
  // 收入回退「其他收入」也不存在 → null
  assert.equal(suggestCategoryId("客户扫码付款", partial, "income"), null);
});
