import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { getIdentityExtensions } from "@/lib/identity/identity-extension-bootstrap";
import { SESSION_COOKIE_NAME } from "@/lib/identity/local-authentication";
import type { NextRequest } from "next/server";
import { z } from "zod";

type AuthOperation = "login" | "logout";
type AuthRouteContext = { params: Promise<{ operation?: string[] }> };

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(1024),
});

export async function GET(request: NextRequest, context: AuthRouteContext): Promise<Response> {
  return handle(request, context, "GET");
}

export async function POST(request: NextRequest, context: AuthRouteContext): Promise<Response> {
  return handle(request, context, "POST");
}

async function handle(
  request: NextRequest,
  context: AuthRouteContext,
  method: "GET" | "POST",
): Promise<Response> {
  const requestId = getRequestId(request);
  const operation = await readOperation(context);
  if (!operation) return apiError("REQUEST_SCHEMA_INVALID", "认证操作不受支持", { requestId });
  if (method === "POST" && !isSameOriginBrowserRequest(request)) {
    return apiError("ACCESS_DENIED", "拒绝跨站认证请求", { requestId });
  }

  const { authenticationProvider } = await getIdentityExtensions();
  if (operation === "login") {
    if (method !== "POST") {
      return apiError("REQUEST_SCHEMA_INVALID", "login 只支持 POST", { requestId });
    }
    const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "/";
    if (!isInternalReturnTo(returnTo)) {
      return apiError("REQUEST_SCHEMA_INVALID", "returnTo 必须是站内相对路径", {
        requestId,
      });
    }
    if (!authenticationProvider.login) {
      return apiError("FEATURE_NOT_READY", "当前认证提供器未声明 login 操作", {
        requestId,
      });
    }
    const parsed = loginSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError("REQUEST_SCHEMA_INVALID", "请输入有效的邮箱和密码", { requestId });
    }
    const result = await authenticationProvider.login(parsed.data);
    if (result.status === "rate_limited") {
      const response = apiError("RATE_LIMITED", "尝试次数过多，请稍后再试", {
        requestId,
        details: { retry_after_seconds: result.retryAfterSeconds },
      });
      response.headers.set("retry-after", String(result.retryAfterSeconds));
      return response;
    }
    if (result.status === "denied") {
      return apiError("AUTHENTICATION_REQUIRED", "邮箱或密码错误", { requestId });
    }
    return apiSuccess(
      {
        authenticated: true,
        return_to: returnTo,
        user: { email: result.user.email, display_name: result.user.displayName },
      },
      {
        headers: {
          "set-cookie": serializeSessionCookie(request, result.sessionToken, result.expiresAt),
        },
      },
    );
  }

  if (method !== "POST") {
    return apiError("REQUEST_SCHEMA_INVALID", "logout 只支持 POST", { requestId });
  }
  if (!authenticationProvider.logout) {
    return apiError("FEATURE_NOT_READY", "当前认证提供器未声明 logout 操作", {
      requestId,
    });
  }
  await authenticationProvider.logout({ headers: request.headers });
  return apiSuccess(
    { loggedOut: true },
    { headers: { "set-cookie": serializeExpiredSessionCookie(request) } },
  );
}

async function readOperation(context: AuthRouteContext): Promise<AuthOperation | null> {
  const operation = (await context.params).operation;
  if (operation?.length !== 1) return null;
  return operation[0] === "login" || operation[0] === "logout" ? operation[0] : null;
}

function isInternalReturnTo(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

/** 浏览器提交 Origin 时必须与反向代理后的公开 origin 一致；无 Origin 的服务调用仍可用。 */
function isSameOriginBrowserRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const expectedProtocol = forwardedProto || request.nextUrl.protocol.replace(":", "");
  const expectedHost = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  try {
    return new URL(origin).origin === `${expectedProtocol}://${expectedHost}`;
  } catch {
    return false;
  }
}

function serializeSessionCookie(request: NextRequest, token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return serializeCookie(request, token, `Expires=${expiresAt.toUTCString()}; Max-Age=${maxAge}`);
}

function serializeExpiredSessionCookie(request: NextRequest): string {
  return serializeCookie(request, "", "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0");
}

function serializeCookie(request: NextRequest, value: string, lifetime: string): string {
  const basePath = process.env.NEXT_PUBLIC_SNOW_BASE_PATH ?? "";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = request.nextUrl.protocol === "https:" || forwardedProto === "https";
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Path=${basePath || "/"}`,
    lifetime,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}
