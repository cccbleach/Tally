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
// 关键词来源：生产流水备注的高频样例（医院/火车票/ETC/京东/山姆/美团/酒店/转账汇款…），
// 第二批来自 440 条未分类流水的复盘（茶饮/售货机/足浴/DOTA/国网电费/e充电/话费/AI 订阅…）。

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
  { pattern: /医院|门诊|住院|体检|药房|药店|药|妇产|保健|口腔|医疗|疫苗|健康管理/, category: "医疗" },
  // 新能源充电写作「e充电/充电订单/充电桩/特来电」，不写「充电」二字本身——
  // 否则「免押租借充电宝」（服务费，归其他支出）会被抢先进交通
  { pattern: /滴滴|打车|出租车|火车票|铁路|12306|ETC|高速|加油|汽油|机票|航空|出行|地铁|公交|停车|顺风车|代驾|租车|乘车|乘車|e充电|充电订单|充电支付|充电桩|特来电|新能源|润诚达|浙[A-Z][0-9A-Z]{4,6}/, category: "交通" },
  { pattern: /酒店|宾馆|住宿|民宿|客栈|客房/, category: "居住" },
  // 智能货柜/售货机/智盘（园区食堂）整类都是饮料零食，直接按容器归类，兜住没有品牌词的商品名
  { pattern: /美团|meituan|饿了么|eleme|外卖|盒马|海底捞|肯德基|麦当劳|星巴克|必胜客|蜜雪|奈雪|古茗|外婆家|莫卡乡村|黑色经典|餐|饮|食|茶|酒|咖啡|奶茶|可乐|零食|小吃|菜|莓|水果|净菜|鲜|面|饭|味|吃|货柜|售卖机|售货机|智盘|馄饨|麻辣烫|香锅|串串|爆炒|小笼包|馒头|虾|榴莲|玉米|胡萝卜|豆腐|蜜薯|坚果|曲奇|椰子水|厨创|大厨|小厨|臭鳜鱼/i, category: "餐饮" },
  { pattern: /京东|淘宝|天猫|山姆|超市|便利店|先用后付|先购后付|拼多多|苏宁|唯品会|商城|商品|购物|自营|百货|美宜佳|专卖店|母婴|shopping|goods|jd/i, category: "购物" },
  // AI/互联网订阅必须在娱乐之前：「Kimi-Vip」要进这里，不能被下面的 vip 抢去娱乐
  { pattern: /deepseek|kimi|moonshot|openai|chatgpt|claude|anthropic|gemini|midjourney|api/i, category: "其他支出" },
  { pattern: /游戏|RPG|会员|娱乐|电影|视频|音乐|steam|大冒险|玩|dota|对战平台|vip|加速器|观影|影城|影院|足浴|足本纪|按摩|皮影|游船/i, category: "娱乐" },
  { pattern: /学费|培训|课程|教育|网课|书/, category: "教育" },
  { pattern: /红包|礼金|婚纱|婚礼|彩礼|人流/, category: "人情" },
  // 资金腾挪/经营往来/保障/生活账单类：不是消费，但流水本体是支出，归「其他支出」。
  // 末尾的掩码手机号（177****3159）是运营商话费充值的备注写法
  { pattern: /转账汇款|微信转账|支付宝转账|支付宝支付|钉钉转账|取现|结售汇|付汇|收款|经营码|待收款|客户扫码付款|代付|直付通|报销|保单|保险|还款|信贷|信用卡|服务器|invoice|宽带|房租|物业|水电|燃气|国网|户号|话费|先充后付|租借|充电宝|火山引擎|腾讯云|阿里云|云服务|云计算|\d{3}\*+\d{2,4}/i, category: "其他支出" },
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
