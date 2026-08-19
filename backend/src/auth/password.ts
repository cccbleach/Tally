import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

// 使用 Node 内置 scrypt 做加盐哈希，格式为 "salt:hash"，无第三方原生依赖。
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return salt + ":" + hash.toString("hex");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const idx = stored.indexOf(":");
  if (idx < 0) return false;
  const salt = stored.slice(0, idx);
  const expected = Buffer.from(stored.slice(idx + 1), "hex");
  const candidate = await scrypt(password, salt, 64);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
