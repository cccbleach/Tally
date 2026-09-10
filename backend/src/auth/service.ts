import { randomUUID, createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, not, or } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { users, authSessions, onboardingTickets, ledgers, categories } from "../db/schema.js";
import { AppError, badRequest, conflict, unauthorized } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import { nicknameKey, validateNickname, isNicknameAvailable, isNicknameUniqueViolation } from "../lib/nickname.js";
import { DEFAULT_CATEGORIES } from "../db/seed.js";
import type { Jwt } from "./jwt.js";
import { config } from "../config.js";

export interface UserDto {
  id: string;
  phone: string;
  nickname: string;
  nicknameChangeAvailableAt: string | null;
  createdAt: string;
}

export type LoginResult =
  | { status: "authenticated"; user: UserRow }
  | { status: "nickname_required"; onboardingToken: string; expiresAt: string };

type UserRow = typeof users.$inferSelect;

const ONBOARDING_TTL_MS = 10 * 60 * 1000; // onboarding ticket 10 分钟
const NICKNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 天改名冷却

export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    phone: u.phone,
    nickname: u.nickname ?? "",
    nicknameChangeAvailableAt: u.nicknameChangedAt
      ? new Date(new Date(u.nicknameChangedAt).getTime() + NICKNAME_CHANGE_COOLDOWN_MS).toISOString()
      : null,
    createdAt: u.createdAt,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function ttlToMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return 30 * 24 * 60 * 60 * 1000;
  }
}

const REFRESH_TTL_MS = ttlToMs(config.refreshTokenTtl);

export function makeAuthService(db: DB, jwt: Jwt) {
  async function buildSessionData(userId: string) {
    const refreshToken = await jwt.signRefresh(userId);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
    return {
      refreshToken,
      accessToken: await jwt.signAccess(userId),
      expiresAt,
      refreshTokenHash: sha256(refreshToken),
      now,
    };
  }

  function insertSessionRow(userId: string, data: Awaited<ReturnType<typeof buildSessionData>>) {
    db.insert(authSessions)
      .values({
        id: randomUUID(),
        userId,
        refreshTokenHash: data.refreshTokenHash,
        deviceName: null,
        expiresAt: data.expiresAt,
        revokedAt: null,
        lastUsedAt: data.now,
        createdAt: data.now,
      })
      .run();
  }

  async function createSession(userId: string): Promise<{ token: string; refreshToken: string }> {
    const data = await buildSessionData(userId);
    insertSessionRow(userId, data);
    return { token: data.accessToken, refreshToken: data.refreshToken };
  }

  function findUserByPhone(phone: string): UserRow | undefined {
    return db.select().from(users).where(eq(users.phone, phone)).get();
  }

  function issueOnboardingTicket(userId: string): { onboardingToken: string; expiresAt: string } {
    const token = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ONBOARDING_TTL_MS).toISOString();
    db.insert(onboardingTickets)
      .values({ id: randomUUID(), userId, tokenHash: sha256(token), expiresAt, createdAt: now })
      .run();
    return { onboardingToken: token, expiresAt };
  }

  function beginLoginByPhone(phone: string): LoginResult {
    const normalized = normalizePhone(phone);
    if (!normalized) throw badRequest("INVALID_PHONE", "请输入有效的中国大陆手机号");
    const existing = findUserByPhone(normalized);
    if (existing) {
      if (existing.profileCompletedAt) {
        return { status: "authenticated", user: existing };
      }
      return { status: "nickname_required", ...issueOnboardingTicket(existing.id) };
    }
    const now = new Date().toISOString();
    const user = {
      id: randomUUID(),
      phone: normalized,
      nickname: null,
      nicknameKey: null,
      phoneVerifiedAt: now,
      nicknameChangedAt: null,
      profileCompletedAt: null,
      defaultLedgerId: null,
      currentLedgerId: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(users).values(user).run();
    return { status: "nickname_required", ...issueOnboardingTicket(user.id) };
  }

  function provisionDefaultLedgerAndCategories(userId: string) {
    const ledgerId = randomUUID();
    const now = new Date().toISOString();
    db.insert(ledgers)
      .values({
        id: ledgerId,
        userId,
        name: "默认账本",
        currency: "CNY",
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.update(users)
      .set({ defaultLedgerId: ledgerId, currentLedgerId: ledgerId, updatedAt: now })
      .where(eq(users.id, userId))
      .run();
    const rows = DEFAULT_CATEGORIES.map((c, i) => ({
      id: randomUUID(),
      userId,
      ledgerId,
      name: c.name,
      type: c.type,
      icon: c.icon,
      color: c.color,
      sortOrder: i,
      createdAt: now,
    }));
    db.insert(categories).values(rows).run();
  }

  async function completeProfile(
    onboardingToken: string,
    nickname: string,
  ): Promise<{ user: UserDto; token: string; refreshToken: string }> {
    if (!onboardingToken) throw badRequest("INVALID_ONBOARDING_TOKEN", "缺少一次性 onboarding 令牌");
    const err = validateNickname(nickname);
    if (err) throw badRequest("INVALID_NICKNAME", err);

    const ticket = db.select().from(onboardingTickets).where(eq(onboardingTickets.tokenHash, sha256(onboardingToken))).get();
    if (!ticket) throw conflict("INVALID_ONBOARDING_TOKEN", "onboarding 令牌无效或已使用");
    const user = db.select().from(users).where(eq(users.id, ticket.userId)).get();
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "用户不存在");
    // 只允许仍未完成资料的用户走 complete-profile；已完成账号使用旧 ticket 必须明确 409，
    // 且不得修改昵称、不得新建 session（无论该 ticket 是否已被作废）。
    if (user.profileCompletedAt) {
      throw conflict("PROFILE_ALREADY_COMPLETED", "账号已完成资料设置，onboarding 令牌已失效");
    }
    if (ticket.usedAt) throw conflict("INVALID_ONBOARDING_TOKEN", "onboarding 令牌已被使用");
    if (new Date(ticket.expiresAt).getTime() < Date.now()) {
      throw conflict("ONBOARDING_TOKEN_EXPIRED", "onboarding 令牌已过期，请重新获取验证码");
    }
    if (!isNicknameAvailable(db, nickname, user.id)) throw conflict("NICKNAME_TAKEN", "该昵称已被使用");

    const sessionData = await buildSessionData(user.id);
    const now = new Date().toISOString();
    const key = nicknameKey(nickname);

    let updated: UserRow | undefined;
    try {
      updated = db.transaction(() => {
        const claimed = db
          .update(onboardingTickets)
          .set({ usedAt: now })
          .where(and(eq(onboardingTickets.id, ticket.id), isNull(onboardingTickets.usedAt)))
          .run();
        if (claimed.changes === 0) throw conflict("INVALID_ONBOARDING_TOKEN", "onboarding 令牌已被使用");

        // 同一事务内作废该用户其他所有未使用 onboarding ticket（防止旧 ticket 被重复认领）。
        db.update(onboardingTickets)
          .set({ usedAt: now })
          .where(
            and(
              eq(onboardingTickets.userId, user.id),
              not(eq(onboardingTickets.id, ticket.id)),
              isNull(onboardingTickets.usedAt),
            ),
          )
          .run();

        db.update(users)
          .set({
            nickname,
            nicknameKey: key,
            nicknameChangedAt: now,
            profileCompletedAt: now,
            updatedAt: now,
          })
          .where(eq(users.id, user.id))
          .run();

        const current = db.select().from(users).where(eq(users.id, user.id)).get();
        if (current && !current.defaultLedgerId) {
          provisionDefaultLedgerAndCategories(user.id);
        }

        insertSessionRow(user.id, sessionData);

        return db.select().from(users).where(eq(users.id, user.id)).get();
      });
    } catch (e) {
      if (isNicknameUniqueViolation(e)) throw conflict("NICKNAME_TAKEN", "该昵称已被使用");
      throw e;
    }
    return { user: toUserDto(updated as UserRow), token: sessionData.accessToken, refreshToken: sessionData.refreshToken };
  }

  async function createAuthenticatedSession(user: UserRow) {
    const session = await createSession(user.id);
    return { user: toUserDto(user), ...session };
  }

  async function refresh(refreshToken: string) {
    let payload;
    try {
      payload = await jwt.verify(refreshToken);
    } catch {
      throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效");
    }
    if (payload.type !== "refresh") throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效");
    const oldHash = sha256(refreshToken);
    const session = db.select().from(authSessions).where(eq(authSessions.refreshTokenHash, oldHash)).get();
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      new Date(session.expiresAt).getTime() < Date.now()
    ) {
      throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效或已失效");
    }
    const nextRefreshToken = await jwt.signRefresh(payload.sub);
    const nextAccessToken = await jwt.signAccess(payload.sub);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
    db.transaction((tx) => {
      // 条件更新：只吊销"仍然有效"的那一行。若 changes === 0，说明并发/重放已经把它用掉了，
      // 此时必须整体失败（否则同一 refresh token 会被轮换出两个新会话）。
      const revoked = tx.update(authSessions)
        .set({ revokedAt: now, lastUsedAt: now })
        .where(and(eq(authSessions.id, session.id), isNull(authSessions.revokedAt)))
        .run();
      if (revoked.changes === 0) throw unauthorized("INVALID_REFRESH_TOKEN", "刷新令牌无效或已失效");
      tx.insert(authSessions)
        .values({
          id: randomUUID(),
          userId: payload.sub,
          refreshTokenHash: sha256(nextRefreshToken),
          deviceName: session.deviceName,
          expiresAt,
          revokedAt: null,
          lastUsedAt: now,
          createdAt: now,
        })
        .run();
    });
    return { token: nextAccessToken, refreshToken: nextRefreshToken };
  }

  async function me(userId: string) {
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw unauthorized("UNAUTHORIZED", "用户不存在");
    return { user: toUserDto(user) };
  }

  // ---------- 会话吊销（服务端登出） ----------
  // 历史缺陷：没有任何服务端登出入口，AppState.logout() 只删本地 Keychain；
  // refresh token 默认 30 天有效，且 auth_sessions.revoked_at 从不用于"用户主动登出"，
  // 令牌一旦泄漏，用户与运维都无法吊销。
  //
  // access token 只含 sub（无会话标识），refresh token 才有 jti 且其哈希落库，
  // 因此"登出当前设备"以客户端提交的 refreshToken 定位会话，无需改动令牌格式。
  function revokeSessionByRefreshToken(userId: string, refreshToken: string): boolean {
    const now = new Date().toISOString();
    const session = db
      .select()
      .from(authSessions)
      .where(eq(authSessions.refreshTokenHash, sha256(refreshToken)))
      .get();
    if (!session || session.userId !== userId || session.revokedAt) return false;
    const res = db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.id, session.id), isNull(authSessions.revokedAt)))
      .run();
    return res.changes > 0;
  }

  // 退出全部设备：吊销该用户所有仍有效的会话
  function revokeAllSessions(userId: string): number {
    const now = new Date().toISOString();
    const res = db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .run();
    return res.changes;
  }

  // 定期清理：过期或已吊销的会话、已用/过期的 onboarding ticket（避免表无限增长）
  function pruneExpiredAuthArtifacts(nowIso = new Date().toISOString()): { sessions: number; tickets: number } {
    const sessions = db
      .delete(authSessions)
      .where(or(lte(authSessions.expiresAt, nowIso), isNotNull(authSessions.revokedAt)))
      .run().changes;
    const tickets = db
      .delete(onboardingTickets)
      .where(or(lte(onboardingTickets.expiresAt, nowIso), isNotNull(onboardingTickets.usedAt)))
      .run().changes;
    return { sessions, tickets };
  }

  return {
    beginLoginByPhone,
    completeProfile,
    createAuthenticatedSession,
    refresh,
    me,
    revokeSessionByRefreshToken,
    revokeAllSessions,
    pruneExpiredAuthArtifacts,
  };
}
