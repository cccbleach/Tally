import type { FastifyInstance } from "fastify";

// 通过短信验证码 + 强制昵称流程完成注册/登录，返回完整响应体。
// 仅适用于全新手机号（未注册）。开发模式回传验证码，无需真实短信。
export async function smsRegister(app: FastifyInstance, phone: string, nickname: string) {
  const codeRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/request-code",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phone }),
  });
  if (codeRes.statusCode !== 200) throw new Error("request-code failed: " + codeRes.body);
  const code = codeRes.json().code as string;

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login-code",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phone, code }),
  });
  if (login.statusCode !== 200) throw new Error("login-code failed: " + login.body);
  const first = login.json();
  if (first.status !== "nickname_required") {
    throw new Error("expected nickname_required for new phone, got: " + JSON.stringify(first));
  }
  const complete = await app.inject({
    method: "POST",
    url: "/api/v1/auth/complete-profile",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ onboardingToken: first.onboardingToken, nickname }),
  });
  if (complete.statusCode !== 200) throw new Error("complete-profile failed: " + complete.body);
  return complete.json();
}

// 用手机号登录已有完整账号：request-code → login-code → authenticated。
export async function smsLogin(app: FastifyInstance, phone: string) {
  const codeRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/request-code",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phone }),
  });
  if (codeRes.statusCode !== 200) throw new Error("request-code failed: " + codeRes.body);
  const code = codeRes.json().code as string;
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login-code",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phone, code }),
  });
  if (login.statusCode !== 200) throw new Error("login-code failed: " + login.body);
  return login.json();
}

export function authHeaders(body: { token: string }): Record<string, string> {
  return { authorization: "Bearer " + body.token };
}
