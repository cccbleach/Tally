#!/usr/bin/env node
// 真实容器级回归断言（与 CI 的「拉起完整 HTTPS 栈」步骤、本地发布验收共用同一实现）。
//
// 用法（已先 `docker compose -f backend/docker-compose.caddy.yml up -d` 拉起完整栈）：
//   TALLY_DOMAIN=<域名> node scripts/check-compose-live.mjs [compose-file]
//
// 断言：
//   1) tally-backend 与 tally-caddy 均为 running 且 healthy
//      —— 对 caddy:2（Alpine/busybox、无 bash）的 healthcheck 做真机级回归；
//   2) tally-backend 仍只 expose 8080、未向宿主发布任何端口；
//      tally-caddy 必须把 80/443 发布到宿主；
//   3) 通过 Caddy HTTPS 反代访问 https://<TALLY_DOMAIN>/health/ready 返回 200 且 status="ok"。
// 不使用 `docker compose config`，也不看静态文件——这里只相信运行中的真实容器状态。
import { execFileSync } from "node:child_process";

const domain = process.env.TALLY_DOMAIN;
if (!domain) throw new Error("必须设置 TALLY_DOMAIN（CI/本地无外部 DNS 时请用 localhost，Caddy 会自动用内发自签证书）");

const composeFile = process.argv[2] ?? "backend/docker-compose.caddy.yml";

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 1) 双服务必须 running + healthy
for (const name of ["tally-backend", "tally-caddy"]) {
  const state = docker(["inspect", "-f", "{{.State.Status}}", name]);
  const health = docker(["inspect", "-f", "{{.State.Health.Status}}", name]);
  if (state !== "running" || health !== "healthy") {
    throw new Error(`${name} 未 healthy：State=${state} Health=${health}（请先 docker compose -f ${composeFile} up -d 并等待就绪）`);
  }
  console.log(`✅ ${name}：running / healthy`);
}

// 2) 暴露面运行时复核
function publishedPorts(name) {
  const raw = docker(["inspect", "-f", "{{json .NetworkSettings.Ports}}", name]);
  const map = JSON.parse(raw);
  const out = new Map();
  for (const [containerPort, bindings] of Object.entries(map)) {
    if (Array.isArray(bindings) && bindings.length > 0) out.set(containerPort, bindings);
  }
  return out;
}
const bePublic = publishedPorts("tally-backend");
if (bePublic.size !== 0) throw new Error("tally-backend 不应向宿主发布任何端口： " + JSON.stringify([...bePublic]));
const cdPublic = publishedPorts("tally-caddy");
if (!cdPublic.has("80/tcp") || !cdPublic.has("443/tcp")) {
  throw new Error("tally-caddy 必须把 80/tcp 与 443/tcp 发布到宿主，实际：" + JSON.stringify([...cdPublic]));
}
console.log("✅ tally-backend 未发布宿主端口（8080 仅 Docker 内网）");
console.log("✅ tally-caddy 已发布宿主端口：", JSON.stringify([...cdPublic]));

// 3) HTTPS 反代端到端：/health/ready（用 Node 内置 fetch，免依赖 curl；自签证书可接受）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const resp = await fetch(`https://${domain}/health/ready`);
const text = await resp.text();
if (!resp.ok) throw new Error(`/health/ready HTTP ${resp.status}: ${text}`);
const body = JSON.parse(text);
if (body.status !== "ok") throw new Error(`/health/ready 未返回 ok： ${text}`);
console.log(`✅ HTTPS 反代 https://${domain}/health/ready -> 200 ${text.trim()}`);

console.log("✅ 真实容器级回归通过：双服务 healthy + HTTPS 反代可达 /health/ready");
