import { apiError, getRequestId } from "@/lib/http";
import { NextResponse } from "next/server";

/**
 * POST /api/session/exchange — 登录回跳票据落地（SPA 引导用）。
 *
 * 取代原 Next middleware 的票据拦截（页面层已迁出 nexharness，阶段③）：
 * 1. 取出 ticket，向 auth-center `POST /api/session/resolve` 一次性兑换会话。
 * 2. 会话 token 写入 `nex_session` cookie（HttpOnly）。
 * 3. 返回 200 { ok: true }（SPA 抹掉地址栏 ticket 后继续渲染）。
 *
 * 失败（票据无效/服务不可达）→ 401/503，SPA 回到 /login 重新走登录
 * （auth-center 会重新签发新票据）。
 */
export const dynamic = "force-dynamic";

function authCenterBaseUrl(): string {
  return (process.env.NEX_AUTH_CENTER_URL ?? "http://localhost:3101").replace(/\/+$/, "");
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let body: { ticket?: unknown };
  try {
    body = (await request.json()) as { ticket?: unknown };
  } catch {
    return apiError("REQUEST_SCHEMA_INVALID", "请求体不是合法 JSON", { requestId });
  }
  const ticket = typeof body?.ticket === "string" ? body.ticket.trim() : "";
  if (!ticket) {
    return apiError("REQUEST_SCHEMA_INVALID", "缺少 ticket", { requestId });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${authCenterBaseUrl()}/api/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch {
    return apiError("IDENTITY_SERVICE_UNAVAILABLE", "身份服务暂不可用，请稍后重试", { requestId });
  }
  if (!upstream.ok) {
    return apiError("AUTHENTICATION_REQUIRED", "票据无效或已过期，请重新登录", { requestId });
  }

  const payload = (await upstream.json().catch(() => null)) as {
    sessionToken?: string;
    expiresAt?: string;
  } | null;
  if (!payload?.sessionToken) {
    return apiError("AUTHENTICATION_REQUIRED", "票据兑换响应异常，请重新登录", { requestId });
  }

  const response = NextResponse.json({ ok: true }, { headers: { "x-request-id": requestId } });
  const secure =
    request.headers.get("x-forwarded-proto") === "https" ||
    new URL(request.url).protocol === "https:";
  response.cookies.set("nex_session", payload.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    ...(payload.expiresAt ? { expires: new Date(payload.expiresAt) } : {}),
  });
  return response;
}
