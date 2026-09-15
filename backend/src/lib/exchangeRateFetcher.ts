import { setRate } from "./currency.js";
import { config } from "../config.js";
import type { DB } from "../db/client.js";

// 汇率自动拉取（opt-in，见 config.exchangeRateFetchEnabled）：
//
// - 默认源是 open.er-api.com 的免费无密钥接口（返回 { result, base_code, rates }）；
//   可通过 EXCHANGE_RATE_FETCH_URL 换成任何同构 JSON 源（自建代理/内网镜像）。
// - 结果 upsert 到**全局兜底汇率**（userId IS NULL）：用户级手工 setRate 仍然优先。
// - 任何失败只记日志、不抛出到调度层、绝不删除已有汇率（宁可旧数据也不无数据）。
export interface FetchedRates {
  base: string;
  rates: Record<string, number>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type { FetchLike };

export function parseRatesPayload(json: unknown): FetchedRates {
  if (typeof json !== "object" || json === null) throw new Error("汇率响应不是 JSON 对象");
  const obj = json as { result?: unknown; base_code?: unknown; rates?: unknown };
  if (typeof obj.result === "string" && obj.result !== "success") {
    throw new Error(`汇率源返回失败状态：${obj.result}`);
  }
  const base = typeof obj.base_code === "string" ? obj.base_code.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(base)) throw new Error("汇率响应缺少合法 base_code");
  if (typeof obj.rates !== "object" || obj.rates === null) throw new Error("汇率响应缺少 rates 字段");
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(obj.rates as Record<string, unknown>)) {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) continue;
    if (normalized === base) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    rates[normalized] = value;
  }
  if (Object.keys(rates).length === 0) throw new Error("汇率响应里没有可用的币种汇率");
  return { base, rates };
}

/** 拉取并写入全局兜底汇率。返回写入条数。
 *
 *  `targetBase` 默认取部署基准币（config.baseCurrency）。为什么需要它：
 *  汇率源按**自己的基准**报价（默认 URL 是 CNY 基准），而查表 `getRate(currency, base)`
 *  用的是部署基准。两者不一致时，抓取写入的行永远查不到，于是回退到内置兜底表——
 *  而内置表是**人民币视角**，被当成目标基准使用会**静默算错**约 7 倍（USD/CNY 倍数）。
 *  因此这里把响应交叉换算到部署基准：rate(目标→X) = rates[X] / rates[目标]。
 */
export async function fetchAndStoreGlobalRates(
  db: DB,
  url: string,
  fetchImpl: FetchLike = globalFetch(),
  targetBase: string = config.baseCurrency,
): Promise<{ base: string; stored: number }> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`汇率源 HTTP ${response.status}`);
  const json: unknown = await response.json();
  const parsed = parseRatesPayload(json);

  const target = targetBase.trim().toUpperCase();
  let base = parsed.base;
  let rates = parsed.rates;

  if (parsed.base !== target) {
    const targetPerBase = parsed.rates[target];
    if (targetPerBase === undefined || !Number.isFinite(targetPerBase) || targetPerBase <= 0) {
      throw new Error(
        `汇率源基准为 ${parsed.base}，与部署基准 ${target} 不一致，且响应里没有 ${target} 汇率，无法换算；` +
          `请改用与基准一致的源（如 https://open.er-api.com/v6/latest/${target}）。` +
          "若直接按对方基准写入，本部署的换算会回退到人民币视角的内置兜底表而静默算错。",
      );
    }
    // 先整体换算完成再写库：任何失败都不留下半套基准的脏数据
    const rebased: Record<string, number> = {};
    for (const [code, rate] of Object.entries(parsed.rates)) {
      if (code === target) continue;
      rebased[code] = rate / targetPerBase;
    }
    // 源基准自身被 parseRatesPayload 作为"基准"排除了（CNY），但归一化到目标基准后
    // 它就是一个普通币种，必须补回：否则 (CNY → USD) 查表落空会回退到内置表 CNY=1，
    // 又是静默算错（偏差恰为 USD/CNY 倍数）。
    rebased[parsed.base] = 1 / targetPerBase;
    rates = rebased;
    base = target;
    console.log(`汇率源基准 ${parsed.base} 已按 ${target} 重新折算（1 ${target} = ${base} 基准下的换算值）`);
  }

  let stored = 0;
  for (const [code, rate] of Object.entries(rates)) {
    setRate(db, null, base, code, rate);
    stored += 1;
  }
  return { base, stored };
}

/** 调度层包装：吞掉一切错误（网络/解析/写库），只留下日志。 */
export async function runExchangeRateFetchSafely(
  db: DB,
  url: string,
  fetchImpl: FetchLike = globalFetch(),
  targetBase?: string,
): Promise<boolean> {
  try {
    const { base, stored } = await fetchAndStoreGlobalRates(db, url, fetchImpl, targetBase);
    console.log(`汇率已刷新：基准 ${base}，写入 ${stored} 个币种的全局兜底汇率`);
    return true;
  } catch (error) {
    console.error("汇率拉取失败（保留现有汇率）:", error instanceof Error ? error.message : error);
    return false;
  }
}

function globalFetch(): FetchLike {
  return (url, init) => fetch(url, init);
}
