import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

export interface JwtPayload {
  sub: string;
  type?: "access" | "refresh" | "reset"; // 兼容旧 token（无 type）视为 access
}

export function makeJwt(secret: string) {
  const key = new TextEncoder().encode(secret);
  return {
    async signAccess(userId: string): Promise<string> {
      return await new SignJWT({ sub: userId, type: "access" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(config.accessTokenTtl)
        .sign(key);
    },
    async signRefresh(userId: string): Promise<string> {
      return await new SignJWT({ sub: userId, type: "refresh" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(config.refreshTokenTtl)
        .sign(key);
    },
    async signReset(userId: string): Promise<string> {
      return await new SignJWT({ sub: userId, type: "reset" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("30m") // 重置令牌短效
        .sign(key);
    },
    async verify(token: string): Promise<JwtPayload> {
      const { payload } = await jwtVerify(token, key);
      if (!payload.sub) throw new Error("令牌缺少 subject");
      return { sub: payload.sub as string, type: payload.type as JwtPayload["type"] | undefined };
    },
  };
}

export type Jwt = ReturnType<typeof makeJwt>;
