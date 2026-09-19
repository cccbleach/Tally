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

test("支出：第二批关键词（未分类流水复盘出的真实样例）", () => {
  const cases: Array<[string, string]> = [
    // 用户点名的人工判定样例
    ["DeepSeek-API服务(188******31)", "c-qita"],
    ["超级吃货卡", "c-canyin"],
    ["智能货柜消费_三得利无糖乌龙茶500ml_消费时间:2026-01-29 10:23", "c-canyin"],
    ["智能货柜消费_沃隆每日坚果A混合果仁25g_消费时间:2026-01-09 16:40", "c-canyin"],
    // 茶饮/酒水/餐馆
    ["CHAGEE霸王茶姬（浙江杭州余杭阿里巴巴西溪A区店）", "c-canyin"],
    ["酒钥匙（亲橙里店）", "c-canyin"],
    ["外婆家杭州亲橙里店", "c-canyin"],
    ["厨创东北大厨（亲橙里店）", "c-canyin"],
    ["福鼎肉片馄饨排骨藕汤(4283)", "c-canyin"],
    ["美川小居麻辣香锅未来科技城店", "c-canyin"],
    ["越南 金枕榴莲 散称", "c-canyin"],
    ["扫码付款_东广场芭比馒头", "c-canyin"],
    ["盛马售货机仅售2999元-统一冰红茶500ml", "c-canyin"],
    ["智盘消费_杭州-西溪园区A5-中华小厨A（西溪A区店）-7393", "c-canyin"],
    // 购物
    ["美宜佳浙01975店", "c-gouwu"],
    ["快捷支付 美商海盗船专卖店", "c-gouwu"],
    ["快捷支付 JD Health (HK) Limited", "c-gouwu"],
    ["shopping", "c-gouwu"],
    ["先购后付", "c-gouwu"],
    // 生活账单/资金往来 → 其他支出
    ["Kimi-Vip", "c-qita"],
    ["网上国网", "c-qita"],
    ["为18813920931话费充值", "c-qita"],
    ["为177****3159充值100.0元，谨防诈骗", "c-qita"],
    ["户号1400512570账单缴费", "c-qita"],
    ["先充后付", "c-qita"],
    ["免押租借充电宝", "c-qita"],
    ["银联无卡自助消费 （特约）平安口袋银行（信用卡", "c-qita"],
    ["钉钉转账", "c-qita"],
    // 交通（新能源充电/车牌停车/租车/乘车）
    ["e充电订单", "c-jiaotong"],
    ["充电支付", "c-jiaotong"],
    ["特来电充值", "c-jiaotong"],
    ["湖北交投新能源投资有限公司", "c-jiaotong"],
    ["快捷支付 润诚达", "c-jiaotong"],
    ["95号车用乙醇汽油(E10)(VIB) 35.62 升", "c-jiaotong"],
    ["神州租车", "c-jiaotong"],
    ["2026-02-13乘车", "c-jiaotong"],
    ["港鐵乘車", "c-jiaotong"],
    ["通道支付 杭州西溪天街 浙AE28248", "c-jiaotong"],
    // 居住/医疗/娱乐
    ["【亲橙客栈】周末特惠房高级客房199元/晚，员工亲友专享价 ，需提前预约哦~", "c-juzhu"],
    ["浙江疫苗安心宝", "c-yiliao"],
    ["银联快捷支付 杭州余杭盲左健康管理门市部", "c-yiliao"],
    ["DOTA2MOD全功能魔法助手辅助换肤国服演技派上分利器Melonity", "c-yule"],
    ["16对战平台账号 自己设置密码和自定义昵称 16平台账号即拍即用", "c-yule"],
    ["白金VIP升级星钻VIP30天", "c-yule"],
    ["银联快捷支付 网易UU加速器", "c-yule"],
    ["3张[5元观影代金券]", "c-yule"],
    ["足本纪（文二西路店）", "c-yule"],
  ];
  for (const [note, expected] of cases) {
    assert.equal(suggestCategoryId(note, cats, "expense"), expected, note);
  }
});

test("支出：顺序敏感的边界——相近词不能串类", () => {
  // 充电宝是租借服务费，不是新能源充电
  assert.equal(suggestCategoryId("免押租借充电宝", cats, "expense"), "c-qita");
  assert.equal(suggestCategoryId("漂流伞租借费", cats, "expense"), "c-qita");
  // Kimi-Vip 是 AI 订阅，不能被 vip 抢去娱乐
  assert.equal(suggestCategoryId("Kimi-Vip", cats, "expense"), "c-qita");
  assert.equal(suggestCategoryId("白金VIP升级星钻VIP30天", cats, "expense"), "c-yule");
  // 酒店是住宿，酒钥匙才是酒水
  assert.equal(suggestCategoryId("酒店", cats, "expense"), "c-juzhu");
  assert.equal(suggestCategoryId("酒钥匙（亲橙里店）", cats, "expense"), "c-canyin");
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
