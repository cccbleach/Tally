// 与 .github/workflows/ci.yml 中「docker compose 配置校验」步骤一致的断言。
// 用法: node scripts/check-compose-topology.mjs <rendered.json>
// 断言：只有 caddy 暴露 80/443；后端不对宿主发布任何端口；两服务同网络；
//       healthcheck / restart / 持久卷齐全；命名卷包含数据卷。
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("用法: node scripts/check-compose-topology.mjs <rendered.json>");
  process.exit(2);
}
const c = JSON.parse(fs.readFileSync(file, "utf8"));
const be = c.services?.["tally-backend"];
const cd = c.services?.["caddy"];
if (!be || !cd) throw new Error("缺少 tally-backend / caddy 服务定义");

const published = (svc) =>
  (svc?.ports ?? []).flatMap((p) => [].concat(p.published ?? [])).map(String);

const bePub = published(be);
const cdPub = published(cd).slice().sort();
console.log("backend  发布到宿主的端口:", JSON.stringify(bePub));
console.log("caddy    发布到宿主的端口:", JSON.stringify(cdPub));

if (bePub.length !== 0) throw new Error("backend 不应向宿主发布任何端口（8080 只能走 Docker 内网）");
if (JSON.stringify(cdPub) !== JSON.stringify(["443", "80"]))
  throw new Error("caddy 只应暴露 80/443，实际 " + JSON.stringify(cdPub));

for (const [name, svc] of Object.entries(c.services)) {
  if (!svc.healthcheck?.test) throw new Error(name + " 缺少 healthcheck");
  if (!svc.restart) throw new Error(name + " 缺少 restart 策略");
  const vols = svc.volumes ?? {};
  if (Object.keys(vols).length === 0) throw new Error(name + " 缺少持久卷");
}

const nb = Object.keys(be.networks ?? {});
const nc = Object.keys(cd.networks ?? {});
if (!nb.some((n) => nc.includes(n))) throw new Error("caddy 与 backend 不在同一网络: " + nb + " vs " + nc);

const volumes = Object.keys(c.volumes ?? {});
for (const need of ["tally-data", "caddy_data", "caddy_config"]) {
  if (!volumes.includes(need)) throw new Error("缺少命名卷: " + need);
}
if (c.networks?.["tally-edge"]?.internal === true)
  throw new Error("tally-edge 不能是 internal 网络：Caddy 需要出网申请证书");

console.log("网络:", JSON.stringify({ backend: nb, caddy: nc }));
console.log("命名卷:", JSON.stringify(volumes));
console.log("restart:", be.restart, "/", cd.restart);
console.log("✅ compose 拓扑合规：仅 80/443 暴露、后端仅内网、healthcheck/restart/持久卷齐全、同网络");
