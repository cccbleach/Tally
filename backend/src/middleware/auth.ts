import type { FastifyReply, FastifyRequest } from "fastify";
import { unauthorized } from "../lib/errors.js";
import type { Jwt } from "../auth/jwt.js";

export const USER_ID_KEY = Symbol("userId");

export function makeAuth(jwt: Jwt) {
  return async function auth(request: FastifyRequest, _reply: FastifyReply) {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw unauthorized("UNAUTHORIZED", "未登录或令牌缺失");
    }
    try {
      const payload = await jwt.verify(header.slice(7));
      // 严格类型：仅 access token 可访问业务接口，refresh/reset/无类型一律拒绝
      if (payload.type !== "access") {
        throw unauthorized("UNAUTHORIZED", "请使用访问令牌");
      }
      (request as unknown as { [USER_ID_KEY]: string })[USER_ID_KEY] = payload.sub;
    } catch {
      throw unauthorized("UNAUTHORIZED", "令牌无效或已过期");
    }
  };
}

export function getUserId(request: FastifyRequest): string {
  const v = (request as unknown as { [USER_ID_KEY]?: string })[USER_ID_KEY];
  if (!v) throw unauthorized("UNAUTHORIZED", "未登录或令牌缺失");
  return v;
}
