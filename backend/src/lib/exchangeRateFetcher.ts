import { setRate } from "./currency.js";
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

/** 拉取并写入全局兜底汇率。返回写入条数。 */
export async function fetchAndStoreGlobalRates(
  db: DB,
  url: string,
  fetchImpl: FetchLike = globalFetch(),
): Promise<{ base: string; stored: number }> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`汇率源 HTTP ${response.status}`);
  const json: unknown = await response.json();
  const { base, rates } = parseRatesPayload(json);
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
): Promise<boolean> {
  try {
    const { base, stored } = await fetchAndStoreGlobalRates(db, url, fetchImpl);
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
