/**
 * 票据落地中间件（消费方登录回跳）。
 *
 * auth-center 登录完成后把用户回跳到本应用的原始地址并附 `?ticket=`；
 * 本中间件在任何页面渲染前拦截：
 * 1. 取出 ticket，向 auth-center `POST /api/session/resolve` 一次性兑换会话。
 * 2. 会话 token 写入 `nex_session` cookie（HttpOnly）。
 * 3. 302 到去掉 ticket 的干净地址（票据绝不留在浏览器地址栏/历史）。
 *
 * 失败（票据无效/服务不可达）→ 去掉 ticket 后回到 /login 重新走登录（重新签发）。
 * 自包含实现（不 import 应用模块），保持 edge 运行时最小依赖。
 */
import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "nex_session";

function authCenterBaseUrl(): string {
  return (process.env.NEX_AUTH_CENTER_URL ?? "http://localhost:3101").replace(/\/+$/, "");
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ticket = request.nextUrl.searchParams.get("ticket");
  if (!ticket) return NextResponse.next();

  const clean = request.nextUrl.clone();
  clean.searchParams.delete("ticket");

  try {
    const response = await fetch(`${authCenterBaseUrl()}/api/session/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        sessionToken?: string;
        expiresAt?: string;
      } | null;
      if (body?.sessionToken) {
        const redirect = NextResponse.redirect(clean);
        redirect.cookies.set(SESSION_COOKIE_NAME, body.sessionToken, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: request.nextUrl.protocol === "https:",
          ...(body.expiresAt ? { expires: new Date(body.expiresAt) } : {}),
        });
        return redirect;
      }
    }
  } catch {
    // 兑换失败：继续走下方重新登录路径（auth-center 会重新签发新票据）。
  }

  const returnTo = `${clean.pathname}${clean.search}`;
  return NextResponse.redirect(
    new URL(`/login?returnTo=${encodeURIComponent(returnTo)}`, request.url),
  );
}

export const config = {
  // 跳过静态资源与 API（票据只落在页面地址上）。
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|brand/).*)"],
};
