import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/runner.js";
import { buildApp } from "../src/server.js";
import { familyInvitations, familyMembers } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { smsRegister, authHeaders } from "./helpers.js";
import { isSingleActiveFamilyViolation } from "../src/modules/families.js";

// 回归：家庭邀请状态机。
// - accept/decline/revoke 只能从 pending 条件更新，重复/非法转换统一 409。
// - 接受一个邀请后，撤销该用户【所有其他家庭】的 pending 邀请（不限当前 familyId）。
// - 已属于某个家庭的用户不能再被其他家庭创建新邀请（409 ALREADY_IN_FAMILY）。

process.env.ALIYUN_SMS_ENABLED = "false";
process.env.ALIYUN_ACCESS_KEY_ID = "";
process.env.ALIYUN_ACCESS_KEY_SECRET = "";

let app: FastifyInstance;
let db: ReturnType<typeof createDb>["db"];
let sqlite: ReturnType<typeof createDb>["sqlite"];
let dir: string;

function api(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
}

async function makeUser(phone: string, nickname: string) {
  const r = await smsRegister(app, phone, nickname);
  return { headers: authHeaders(r), id: r.user.id };
}

async function createFamily(headers: Record<string, string>, name: string) {
  const r = await api(headers, "POST", "/api/v1/families", { name });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().item.id as string;
}

async function invite(headers: Record<string, string>, familyId: string, nickname: string) {
  const r = await api(headers, "POST", `/api/v1/families/${familyId}/invitations`, { nickname });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().item.id as string;
}

async function inviteStatus(inviteId: string): Promise<string> {
  const row = db.select().from(familyInvitations).where(eq(familyInvitations.id, inviteId)).get()!;
  return row.status as string;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tally-invite-fsm-"));
  const created = createDb(join(dir, "test.db"));
  db = created.db;
  sqlite = created.sqlite;
  runMigrations(sqlite, resolve("./migrations"));
  app = await buildApp({ db, jwtSecret: "test-secret" });
});

after(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("重复邀请 → INVITATION_EXISTS", async () => {
  const owner = await makeUser("13871000001", "州机主");
  const target = await makeUser("13871000002", "州目标");
  const fam = await createFamily(owner.headers, "家庭甲");
  await invite(owner.headers, fam, "州目标");
  const again = await api(owner.headers, "POST", `/api/v1/families/${fam}/invitations`, { nickname: "州目标" });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error.code, "INVITATION_EXISTS");
});

test("接受邀请后撤销该用户所有其他家庭的 pending 邀请（不限当前 familyId）", async () => {
  const oa = await makeUser("13872000001", "甲家主");
  const ob = await makeUser("13872000002", "乙家主");
  const target = await makeUser("13872000003", "叉目标");

  const fa = await createFamily(oa.headers, "甲之家");
  const fb = await createFamily(ob.headers, "乙之家");
  // 目标尚未属于任何家庭，两家的邀请都要能创建
  const inviteA = await invite(oa.headers, fa, "叉目标");
  const inviteB = await invite(ob.headers, fb, "叉目标");

  const pending = await api(target.headers, "GET", "/api/v1/families/invitations/pending");
  assert.equal(pending.json().items.length, 2, "应先有 2 个待处理邀请");

  // 接受甲之家 → 乙之家邀请应被自动撤销（不同家庭）
  const accept = await api(target.headers, "POST", `/api/v1/families/invitations/${inviteA}/accept`);
  assert.equal(accept.statusCode, 200, accept.body);
  assert.equal(await inviteStatus(inviteA), "accepted");
  assert.equal(await inviteStatus(inviteB), "revoked", "其他家庭的 pending 邀请应被撤销（不限 current familyId）");

  const pendingAfter = await api(target.headers, "GET", "/api/v1/families/invitations/pending");
  assert.equal(pendingAfter.json().items.length, 0, "接受后应无待处理邀请");
});

test("重复接受 / 重复拒绝 / 已处理撤销 → 统一 409", async () => {
  // 每个子场景使用独立 owner 与 target（单家庭：一人只能进一个家庭）
  {
    const oa = await makeUser("13873000001", "甲机主");
    const t1 = await makeUser("13873000002", "机一");
    const fa = await createFamily(oa.headers, "乙之家");
    const ia = await invite(oa.headers, fa, "机一");
    const accept = await api(t1.headers, "POST", `/api/v1/families/invitations/${ia}/accept`);
    assert.equal(accept.statusCode, 200);
    const repeatAccept = await api(t1.headers, "POST", `/api/v1/families/invitations/${ia}/accept`);
    assert.equal(repeatAccept.statusCode, 409, repeatAccept.body);
    assert.equal(repeatAccept.json().error.code, "INVITATION_EXISTS");
  }

  {
    const o2 = await makeUser("13873000004", "丙机主");
    const t2 = await makeUser("13873000003", "机二");
    const fi = await createFamily(o2.headers, "丙之家");
    const ii = await invite(o2.headers, fi, "机二");
    const decline = await api(t2.headers, "POST", `/api/v1/families/invitations/${ii}/decline`);
    assert.equal(decline.statusCode, 200);
    const repeatDecline = await api(t2.headers, "POST", `/api/v1/families/invitations/${ii}/decline`);
    assert.equal(repeatDecline.statusCode, 409, repeatDecline.body);
  }

  {
    const o3 = await makeUser("13873000006", "权机主");
    const t3 = await makeUser("13873000007", "机三");
    const fd = await createFamily(o3.headers, "丁之家");
    const id1 = await invite(o3.headers, fd, "机三");
    const accept2 = await api(t3.headers, "POST", `/api/v1/families/invitations/${id1}/accept`);
    assert.equal(accept2.statusCode, 200, accept2.body);
    const revokeAccepted = await api(o3.headers, "DELETE", `/api/v1/families/${fd}/invitations/${id1}`);
    assert.equal(revokeAccepted.statusCode, 409, revokeAccepted.body);
  }

  {
    const o4 = await makeUser("13873000008", "戊机主");
    const t4 = await makeUser("13873000009", "机四");
    const fe = await createFamily(o4.headers, "戊之家");
    const ie = await invite(o4.headers, fe, "机四");
    const revoke1 = await api(o4.headers, "DELETE", `/api/v1/families/${fe}/invitations/${ie}`);
    assert.equal(revoke1.statusCode, 200);
    const revoke2 = await api(o4.headers, "DELETE", `/api/v1/families/${fe}/invitations/${ie}`);
    assert.equal(revoke2.statusCode, 409, revoke2.body);
  }
});

test("已属于某个家庭的用户不能再被其他家庭创建新邀请 → 409 ALREADY_IN_FAMILY", async () => {
  const oa = await makeUser("13874000001", "甲甲");
  const ob = await makeUser("13874000002", "乙乙");
  const target = await makeUser("13874000003", "双双");
  const fa = await createFamily(oa.headers, "家庭一方");
  const ia = await invite(oa.headers, fa, "双双");
  const accept = await api(target.headers, "POST", `/api/v1/families/invitations/${ia}/accept`);
  assert.equal(accept.statusCode, 200);

  const fb = await createFamily(ob.headers, "家庭二方");
  const createInvite = await api(ob.headers, "POST", `/api/v1/families/${fb}/invitations`, { nickname: "双双" });
  assert.equal(createInvite.statusCode, 409, createInvite.body);
  assert.equal(createInvite.json().error.code, "ALREADY_IN_FAMILY");
});

test("接受已过期邀请 → 409 INVITATION_EXPIRED", async () => {
  const oa = await makeUser("13875000001", "过期主");
  const target = await makeUser("13875000002", "过期客");
  const fa = await createFamily(oa.headers, "过期之家");
  const ia = await invite(oa.headers, fa, "过期客");
  db.update(familyInvitations)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(familyInvitations.id, ia))
    .run();
  const accept = await api(target.headers, "POST", `/api/v1/families/invitations/${ia}/accept`);
  assert.equal(accept.statusCode, 409, accept.body);
  assert.equal(accept.json().error.code, "INVITATION_EXPIRED");
});

test("故障注入：isSingleActiveFamilyViolation 只精确识别 uniq_family_single_active 唯一索引", () => {
  // 命中：uniq_family_single_active（family_members.user_id 单列唯一）
  assert.equal(
    isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: family_members.user_id" }),
    true,
    "单列 user_id 唯一冲突应识别为单家庭约束",
  );
  assert.equal(
    isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: index 'uniq_family_single_active'" }),
    true,
    "显式索引名也应识别",
  );

  // 不命中：uniq_family_member / uniq_family_member_active（family_id+user_id 组合唯一）
  assert.equal(
    isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: family_members.family_id, family_members.user_id" }),
    false,
    "组合唯一索引不应误报为单家庭约束",
  );

  // 不命中：审计触发器 / 外键 / NOT NULL / CHECK / 主键
  assert.equal(isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "audit trigger boom" }), false, "审计触发器不应误报");
  assert.equal(isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "FOREIGN KEY constraint failed" }), false, "外键不应误报");
  assert.equal(isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_NOTNULL", message: "NOT NULL constraint failed: family_members.family_id" }), false, "NOT NULL 不应误报");
  assert.equal(isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_CHECK", message: "CHECK constraint failed" }), false, "CHECK 不应误报");
  assert.equal(isSingleActiveFamilyViolation({ code: "SQLITE_CONSTRAINT_PRIMARYKEY", message: "UNIQUE constraint failed: family_members.id" }), false, "主键冲突不应误报");
  assert.equal(isSingleActiveFamilyViolation(undefined), false, "空错误不应误报");
  assert.equal(isSingleActiveFamilyViolation({ code: "SQLITE_ERROR", message: "near \":\": syntax error" }), false, "普通 SQL 错误不应误报");
});

test("故障注入：接受邀请时审计触发器失败 → 500 而非误报 ALREADY_IN_FAMILY", async () => {
  const oa = await makeUser("13876000001", "注主甲");
  const target = await makeUser("13876000002", "注标乙");
  const fa = await createFamily(oa.headers, "注入审计之家");
  const ia = await invite(oa.headers, fa, "注标乙");

  // 注入：audit_logs 的审计触发器抛错（模拟审计写入失败）
  sqlite.exec("CREATE TRIGGER inject_audit_fail BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;");
  try {
    const accept = await api(target.headers, "POST", `/api/v1/families/invitations/${ia}/accept`);
    assert.equal(accept.statusCode, 500, "审计触发器失败不应被误报为 409 ALREADY_IN_FAMILY，实际: " + accept.body);
    assert.equal(accept.json().error.code, "INTERNAL", "应保留为内部错误: " + accept.body);
  } finally {
    sqlite.exec("DROP TRIGGER inject_audit_fail");
  }
  // 事务应整体回滚：邀请仍是 pending，成员未加入
  assert.equal(await inviteStatus(ia), "pending", "审计失败应整体回滚，邀请保持 pending");
  const members = db.select().from(familyMembers).where(eq(familyMembers.userId, target.id)).all().filter((m) => m.isActive);
  assert.equal(members.length, 0, "审计失败后不应加入家庭");
});
