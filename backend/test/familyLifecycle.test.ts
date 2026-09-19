import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { todayStr } from "../src/lib/date.js";
import { smsRegister, authHeaders } from "./helpers.js";
import { users, ledgers } from "../src/db/schema.js";
import { and, eq, isNull } from "drizzle-orm";

// 单家庭模型 E2E：
// A 创建家庭 → A 按昵称邀请 B → B 接受（自动撤销其他待处理邀请）→ B 可用共享账本记账
// → 家庭响应不泄露手机号、流水展示记账人昵称 → 单家庭约束（重复创建/重复加入 → 409）
// → Owner 管理：改家庭名/移除成员/转移所有权/删除家庭；Member 退出自动切回个人账本
// → 旧多角色流程统一 410。

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

let hA: Record<string, string>;
let hB: Record<string, string>;
let hC: Record<string, string>;
let idA: string;
let idB: string;
let familyId: string;
let familyLedger: string;
let expenseCatId: string;

function api(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers: h,
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-family-lifecycle-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });

  const regA = await smsRegister(app, "13830000001", "户主阿甲");
  idA = regA.user.id;
  hA = authHeaders(regA);

  const regB = await smsRegister(app, "13830000002", "成员小乙");
  idB = regB.user.id;
  hB = authHeaders(regB);

  const regC = await smsRegister(app, "13830000003", "路人小丙");
  hC = authHeaders(regC);
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("A 创建家庭并邀请 B，B 接受后用共享账本记账，A 看到记账人昵称（无手机号）", async () => {
  const fam = await api(hA, "POST", "/api/v1/families", { name: "幸福之家" });
  assert.equal(fam.statusCode, 200, fam.body);
  familyId = fam.json().item.id;
  familyLedger = fam.json().item.ledgerId;
  assert.ok(familyLedger, "创建家庭应返回家庭账本");

  // A 确认家庭账本分类（账户域已下线，分类即可支撑记账）
  const cats = await api(hA, "GET", "/api/v1/categories?ledgerId=" + familyLedger);
  const expenseCat = (cats.json().items as Array<{ id: string; type: string }>).find((c) => c.type === "expense");
  expenseCatId = expenseCat!.id;

  // A 按昵称邀请 B（不支持手机号）
  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { nickname: "成员小乙" });
  assert.equal(invite.statusCode, 200, invite.body);
  const inviteId = invite.json().item.id as string;
  assert.equal(invite.json().item.targetNickname, "成员小乙");

  // 重复邀请 → INVITATION_EXISTS
  const dup = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { nickname: "成员小乙" });
  assert.equal(dup.statusCode, 409, dup.body);
  assert.equal(dup.json().error.code, "INVITATION_EXISTS");

  // B 查看待处理邀请箱
  const pending = await api(hB, "GET", "/api/v1/families/invitations/pending");
  assert.equal(pending.statusCode, 200, pending.body);
  assert.equal(pending.json().items.length, 1);
  assert.equal(pending.json().items[0].familyName, "幸福之家");
  assert.equal(pending.json().items[0].inviterNickname, "户主阿甲");
  assert.ok(!(JSON.stringify(pending.json()) as string).includes("13830000002"), "邀请箱不应泄露手机号");

  // 再给 B 发另一家的待处理邀请，接受本家时应自动撤销（见单家庭测试）

  // B 接受邀请
  const accept = await api(hB, "POST", `/api/v1/families/invitations/${inviteId}/accept`);
  assert.equal(accept.statusCode, 200, accept.body);

  // B 可用共享账本
  const listB = await api(hB, "GET", "/api/v1/categories?ledgerId=" + familyLedger);
  assert.equal(listB.statusCode, 200, listB.body);
  assert.ok(listB.json().items.length > 0, "B 应能看到共享账本分类");
  const createByB = await api(hB, "POST", "/api/v1/transactions?ledgerId=" + familyLedger, {
    categoryId: expenseCatId,
    type: "expense",
    amount: 888,
    date: todayStr(),
    note: "B 记的第一笔",
    ledgerId: familyLedger,
  });
  assert.equal(createByB.statusCode, 200, createByB.body);

  // A 能看到 B 的流水及记账人昵称，且不含手机号
  const txA = await api(hA, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  const txBody = txA.json();
  const mine = (txBody.items as Array<{ note: string | null; recorderNickname: string | null }>).find((t) => t.note === "B 记的第一笔");
  assert.ok(mine, "A 应能看到 B 的流水");
  assert.equal(mine!.recorderNickname, "成员小乙", "家庭流水应展示记账人昵称");
  assert.ok(!(JSON.stringify(txBody) as string).includes("13830000002"), "家庭流水不应泄露手机号");

  // 家庭详情：成员只含昵称，不含手机号
  const detail = await api(hA, "GET", `/api/v1/families/${familyId}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const bodyStr = JSON.stringify(detail.json()) as string;
  assert.ok(bodyStr.includes("户主阿甲") && bodyStr.includes("成员小乙"), "成员应展示昵称");
  assert.ok(!bodyStr.includes("13830000001") && !bodyStr.includes("13830000002"), "家庭详情不应泄露手机号");
});

test("单家庭约束：已是成员不能再建家庭；接受第二家邀请 → ALREADY_IN_FAMILY", async () => {
  // A 已有一个家庭，再建 → 409
  const again = await api(hA, "POST", "/api/v1/families", { name: "另一个家" });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error.code, "ALREADY_IN_FAMILY");

  // C 建一个家庭并邀请 B；B 已属于幸福之家 → 创建邀请时即返回 ALREADY_IN_FAMILY
  const famC = await api(hC, "POST", "/api/v1/families", { name: "丙之家" });
  assert.equal(famC.statusCode, 200, famC.body);
  const inviteC = await api(hC, "POST", `/api/v1/families/${famC.json().item.id}/invitations`, { nickname: "成员小乙" });
  assert.equal(inviteC.statusCode, 409, inviteC.body);
  assert.equal(inviteC.json().error.code, "ALREADY_IN_FAMILY");
});

test("B 退出家庭后自动切回个人账本", async () => {
  const exit = await api(hB, "POST", `/api/v1/families/${familyId}/exit`);
  assert.equal(exit.statusCode, 200, exit.body);

  const afterExit = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(afterExit.statusCode, 403, "退出后访问家庭账本应 403");

  // 已退出成员创建的历史流水仍应显示记账人昵称（不能因只查 active member 变成 null）
  const txA = await api(hA, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  const mine = (txA.json().items as Array<{ note: string | null; recorderNickname: string | null }>).find((t) => t.note === "B 记的第一笔");
  assert.ok(mine, "退出成员的历史流水仍应存在");
  assert.equal(mine!.recorderNickname, "成员小乙", "历史流水记账人昵称不应因退出而丢失");

  const ledgersB = await api(hB, "GET", "/api/v1/ledgers");
  const personalB = (ledgersB.json().items as Array<{ id: string; familyId: string | null; isCurrent: boolean }>)
    .filter((l) => l.familyId === null)
    .find((l) => l.isCurrent);
  assert.ok(personalB, "B 应切回个人默认账本");
});

test("B 重新加入后被 Owner 移除，同样切回个人账本", async () => {
  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { nickname: "成员小乙" });
  const inviteId = invite.json().item.id as string;
  await api(hB, "POST", `/api/v1/families/invitations/${inviteId}/accept`);
  const pre = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(pre.statusCode, 200, "B 重加入后应可访问");

  const remove = await api(hA, "DELETE", `/api/v1/families/${familyId}/members/${idB}`);
  assert.equal(remove.statusCode, 200, remove.body);
  const afterRemove = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(afterRemove.statusCode, 403, "被移除后访问家庭账本应 403");
  const ledgersB = await api(hB, "GET", "/api/v1/ledgers");
  const personalB = (ledgersB.json().items as Array<{ id: string; familyId: string | null; isCurrent: boolean }>)
    .filter((l) => l.familyId === null)
    .find((l) => l.isCurrent);
  assert.ok(personalB, "被移除后 B 应切回个人默认账本");
});

test("B 重新加入后转移所有权，新 owner 可管理", async () => {
  const invite = await api(hA, "POST", `/api/v1/families/${familyId}/invitations`, { nickname: "成员小乙" });
  const inviteId = invite.json().item.id as string;
  await api(hB, "POST", `/api/v1/families/invitations/${inviteId}/accept`);

  const transfer = await api(hA, "POST", `/api/v1/families/${familyId}/transfer`, { memberUserId: idB });
  assert.equal(transfer.statusCode, 200, transfer.body);

  const detail = await api(hB, "GET", `/api/v1/families/${familyId}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().item.ownerUserId, idB, "所有权应转移给 B");
  const roles = detail.json().item.members as Array<{ userId: string; role: string }>;
  assert.equal(roles.find((m) => m.userId === idA)?.role, "member", "原 owner 应降为 member");
  assert.equal(roles.find((m) => m.userId === idB)?.role, "owner", "新 owner 角色应为 owner");
});

test("删除家庭后原成员无法再访问，软删除保留历史并切回个人账本", async () => {
  const del = await api(hB, "DELETE", `/api/v1/families/${familyId}`);
  assert.equal(del.statusCode, 200, del.body);

  const after = await api(hB, "GET", "/api/v1/transactions?ledgerId=" + familyLedger);
  assert.equal(after.statusCode, 404, "删除后家庭账本不可访问（404）");

  const ledgersB = await api(hB, "GET", "/api/v1/ledgers");
  const personalB = (ledgersB.json().items as Array<{ id: string; familyId: string | null; isCurrent: boolean }>)
    .filter((l) => l.familyId === null)
    .find((l) => l.isCurrent);
  assert.ok(personalB, "删除家庭后成员应切回个人默认账本");
});

test("B 退出 A→加入 C→A 被删除；B 仍属于 C，currentLedgerId 仍是 C 账本", async () => {
  // A 新建家庭 A2，邀请 B 加入后 B 退出（A2 中 B 变成 inactive）
  const famA2 = await api(hA, "POST", "/api/v1/families", { name: "待删之家" });
  assert.equal(famA2.statusCode, 200, famA2.body);
  const a2Id = famA2.json().item.id as string;

  const invA2 = await api(hA, "POST", `/api/v1/families/${a2Id}/invitations`, { nickname: "成员小乙" });
  assert.equal(invA2.statusCode, 200, invA2.body);
  const invA2Id = invA2.json().item.id as string;
  await api(hB, "POST", `/api/v1/families/invitations/${invA2Id}/accept`);

  const exit = await api(hB, "POST", `/api/v1/families/${a2Id}/exit`);
  assert.equal(exit.statusCode, 200, exit.body);

  // B 加入 C 的家庭（丙之家），currentLedgerId 应为 C 的账本
  const cFams = await api(hC, "GET", "/api/v1/families");
  const cFamily = (cFams.json().items as Array<{ id: string; name: string }>).find((f) => f.name === "丙之家");
  assert.ok(cFamily, "C 应仍拥有丙之家");
  const cFamilyId = cFamily!.id;
  const cLedger = db.select().from(ledgers).where(and(eq(ledgers.familyId, cFamilyId), isNull(ledgers.deletedAt))).get();
  assert.ok(cLedger, "C 家庭应有共享账本");

  const invC = await api(hC, "POST", `/api/v1/families/${cFamilyId}/invitations`, { nickname: "成员小乙" });
  assert.equal(invC.statusCode, 200, invC.body);
  const invCId = invC.json().item.id as string;
  await api(hB, "POST", `/api/v1/families/invitations/${invCId}/accept`);

  let bRow = db.select().from(users).where(eq(users.id, idB)).get()!;
  assert.equal(bRow.currentLedgerId, cLedger!.id, "加入 C 后 B 的当前账本应是 C 的账本");

  // A 删除 A2：不应影响 B 在 C 的家庭状态与当前账本
  const del = await api(hA, "DELETE", `/api/v1/families/${a2Id}`);
  assert.equal(del.statusCode, 200, del.body);

  const myFams = await api(hB, "GET", "/api/v1/families");
  assert.equal(myFams.statusCode, 200, myFams.body);
  const items = myFams.json().items as Array<{ id: string; name: string }>;
  assert.equal(items.length, 1, "删除 A 后 B 仍应只属于 C 一个家庭");
  assert.equal(items[0].id, cFamilyId, "B 应仍属于 C 的家庭");
  assert.equal(items[0].name, "丙之家");

  bRow = db.select().from(users).where(eq(users.id, idB)).get()!;
  assert.equal(bRow.currentLedgerId, cLedger!.id, "删除 A 后 B 的 currentLedgerId 仍是 C 账本");

  // A 自己应已切回个人账本（A2 删除后 A 不再属于任何 active 家庭）
  const aRow = db.select().from(users).where(eq(users.id, idA)).get()!;
  assert.ok(aRow.currentLedgerId, "A 应有个人默认账本");
  const aLedger = db.select().from(ledgers).where(eq(ledgers.id, aRow.currentLedgerId!)).get();
  assert.equal(aLedger?.familyId, null, "A 删除家庭后应切回个人账本");
});

test("旧多角色/直接加人流程统一 410 FAMILY_FLOW_REMOVED", async () => {
  // C 建家庭以测试 410 路由存在
  let famC = await api(hC, "GET", "/api/v1/families");
  let cId: string;
  if (famC.json().items.length === 0) {
    const created = await api(hC, "POST", "/api/v1/families", { name: "丙之家" });
    cId = created.json().item.id as string;
  } else {
    cId = famC.json().items[0].id as string;
  }
  const add = await api(hC, "POST", `/api/v1/families/${cId}/members`, { account: "成员小乙" });
  assert.equal(add.statusCode, 410, add.body);
  assert.equal(add.json().error.code, "FAMILY_FLOW_REMOVED", add.body);

  const patchRole = await api(hC, "PATCH", `/api/v1/families/${cId}/members/${idA}`, { role: "admin" });
  assert.equal(patchRole.statusCode, 410, patchRole.body);
  assert.equal(patchRole.json().error.code, "FAMILY_FLOW_REMOVED", patchRole.body);
});
