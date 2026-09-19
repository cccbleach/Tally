// 账单关键词自动分类：按备注/商户口中的关键词猜测分类。
//
// 背景：导入提交曾把所有流水批量挂到「账本第一个支出/收入分类」（生产实测
// 1546 笔支出全部是餐饮、72 笔收入全部是工资），统计因此失真。
// 现在的规则：
//   1) 先按关键词命中分类名（正则按序匹配，先命中先得）；
//   2) 支出没有命中 → 返回 null（UI 显示「未分类」），不再硬塞第一个分类；
//   3) 收入没有命中 → 回退「其他收入」（收入的分类少，几乎都该有归属）；
//   4) 规则里的分类名在账本里不存在时跳过该条规则（分类可自定义，不能假设一定有）。
//
// 这是**启发式**：关键词覆盖不了所有商家写法，允许误分类——用户可在 App 里改。
// 关键词来源：生产流水备注的高频样例（医院/火车票/ETC/京东/山姆/美团/酒店/转账汇款…）。

export type TxType = "income" | "expense";

export interface CategoryOption {
  id: string;
  name: string;
  type: string;
}

interface Rule {
  pattern: RegExp;
  category: string;
}

const EXPENSE_RULES: Rule[] = [
  // 医疗放最前：医院备注里常含「餐/食」等字（如「妇产科医院食堂」）
  { pattern: /医院|门诊|住院|体检|药房|药店|药|妇产|保健|口腔|医疗/, category: "医疗" },
  { pattern: /滴滴|打车|出租车|火车票|铁路|12306|ETC|高速|加油|机票|航空|出行|地铁|公交|停车|顺风车|代驾/, category: "交通" },
  { pattern: /酒店|宾馆|住宿|民宿/, category: "居住" },
  { pattern: /美团|meituan|饿了么|eleme|外卖|盒马|餐|饮|食|咖啡|奶茶|可乐|零食|小吃|菜|莓|水果|净菜|鲜|面|饭|味/i, category: "餐饮" },
  { pattern: /京东|淘宝|天猫|山姆|超市|便利店|先用后付|拼多多|苏宁|唯品会|商城|商品|购物|自营|百货/, category: "购物" },
  { pattern: /游戏|RPG|会员|娱乐|电影|视频|音乐|steam|大冒险|玩/, category: "娱乐" },
  { pattern: /学费|培训|课程|教育|网课|书/, category: "教育" },
  { pattern: /红包|礼金|婚纱|婚礼|彩礼|人流/, category: "人情" },
  // 资金腾挪/经营往来/保障类：不是消费，但流水本体是支出，归「其他支出」
  { pattern: /转账汇款|微信转账|支付宝转账|取现|结售汇|付汇|收款|经营码|待收款|报销|保单|保险|还款|信贷|服务器|invoice|宽带|房租|物业|水电|燃气/i, category: "其他支出" },
];

const INCOME_RULES: Rule[] = [
  { pattern: /工资|代发|薪酬|奖金/, category: "工资" },
  { pattern: /利息|理财|基金|余额宝|收益|分红/, category: "理财" },
];

const INCOME_FALLBACK = "其他收入";

// 返回建议的分类 id；无法建议时返回 null。
export function suggestCategoryId(
  note: string | null | undefined,
  categories: CategoryOption[],
  type: TxType,
): string | null {
  const text = (note ?? "").trim();
  if (!text) return null;
  const rules = type === "income" ? INCOME_RULES : EXPENSE_RULES;
  for (const rule of rules) {
    if (!rule.pattern.test(text)) continue;
    const hit = categories.find((c) => c.type === type && c.name === rule.category);
    if (hit) return hit.id;
  }
  if (type === "income") {
    const fallback = categories.find((c) => c.type === type && c.name === INCOME_FALLBACK);
    if (fallback) return fallback.id;
  }
  return null;
}
