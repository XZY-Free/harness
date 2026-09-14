import { randomBytes, timingSafeEqual } from "node:crypto";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { getIdentityExtensions } from "@/lib/identity/identity-extension-bootstrap";
import {
  PasswordEnrollmentError,
  SESSION_COOKIE_NAME,
  completePasswordEnrollment,
  establishExternalSession,
} from "@/lib/identity/local-authentication";
import { PASSWORD_MAX_LENGTH, isPasswordAcceptable } from "@/lib/identity/password-strength";
import { acceptAuthenticatedEvidence } from "@/lib/identity/resolver";
import type { NextRequest } from "next/server";
import { z } from "zod";

type AuthOperation = "login" | "sso" | "callback" | "setup-password" | "logout";
type AuthRouteContext = { params: Promise<{ operation?: string[] }> };

const SSO_STATE_COOKIE_NAME = "snow_sso_state";
const SSO_RETURN_TO_COOKIE_NAME = "snow_sso_return_to";
const SSO_FLOW_TTL_SECONDS = 10 * 60;

const loginSchema = z.object({
  account: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(1024),
});

const passwordSetupSchema = z
  .object({
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    confirmPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict()
  .refine((value) => value.password === value.confirmPassword, {
    message: "两次输入的密码不一致",
    path: ["confirmPassword"],
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

  const { authenticationProvider, profileSource } = await getIdentityExtensions();
  if (operation === "sso") {
    if (method !== "GET") {
      return apiError("REQUEST_SCHEMA_INVALID", "sso 只支持 GET", { requestId });
    }
    const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "/";
    if (!isInternalReturnTo(returnTo)) {
      return apiError("REQUEST_SCHEMA_INVALID", "returnTo 必须是站内相对路径", { requestId });
    }
    if (!authenticationProvider.beginExternalLogin) {
      return apiError("FEATURE_NOT_READY", "当前认证提供器未声明企业登录操作", { requestId });
    }
    const state = randomBytes(32).toString("base64url");
    const callbackUrl = new URL(
      `${process.env.NEXT_PUBLIC_SNOW_BASE_PATH ?? ""}/api/auth/callback`,
      request.url,
    ).toString();
    const redirect = await authenticationProvider.beginExternalLogin({
      request,
      callbackUrl,
      returnTo,
      state,
    });
    const headers = new Headers({ location: redirect.location });
    headers.append(
      "set-cookie",
      serializeFlowCookie(request, SSO_STATE_COOKIE_NAME, state, SSO_FLOW_TTL_SECONDS),
    );
    headers.append(
      "set-cookie",
      serializeFlowCookie(
        request,
        SSO_RETURN_TO_COOKIE_NAME,
        encodeURIComponent(returnTo),
        SSO_FLOW_TTL_SECONDS,
      ),
    );
    return new Response(null, { status: 302, headers });
  }

  if (operation === "callback") {
    if (method !== "GET") {
      return apiError("REQUEST_SCHEMA_INVALID", "callback 只支持 GET", { requestId });
    }
    if (!authenticationProvider.completeExternalLogin) {
      return apiError("FEATURE_NOT_READY", "当前认证提供器未声明企业回调操作", { requestId });
    }
    const expectedState = readCookie(request.headers, SSO_STATE_COOKIE_NAME);
    const actualState = request.nextUrl.searchParams.get("state");
    if (!expectedState || !actualState || !equalOpaqueValues(expectedState, actualState)) {
      return apiError("ACCESS_DENIED", "企业登录状态校验失败，请重新登录", { requestId });
    }
    const returnTo = decodeReturnTo(readCookie(request.headers, SSO_RETURN_TO_COOKIE_NAME));
    const result = await authenticationProvider.completeExternalLogin(request);
    if (result.status === "unauthenticated") {
      return apiError("AUTHENTICATION_REQUIRED", "企业认证未完成", { requestId });
    }
    if (result.status === "denied") {
      return apiError("ACCESS_DENIED", result.reason, { requestId });
    }
    const loginAccount = result.evidence.loginAccount?.trim().toLowerCase();
    if (!loginAccount || loginAccount.length > 128) {
      return apiError("ACCESS_DENIED", "企业认证结果缺少有效账号", { requestId });
    }
    const principal = await acceptAuthenticatedEvidence(result.evidence, "employee", {
      profileSource,
    });
    const session = await establishExternalSession({
      userIdentityId: principal.userIdentityId,
      loginAccount,
    });
    const destination =
      session.status === "password_setup_required"
        ? `/setup-password?returnTo=${encodeURIComponent(returnTo)}`
        : returnTo;
    const headers = new Headers({
      location: new URL(withBasePath(destination), request.url).toString(),
    });
    headers.append(
      "set-cookie",
      serializeSessionCookie(request, session.sessionToken, session.expiresAt),
    );
    headers.append("set-cookie", serializeExpiredNamedCookie(request, SSO_STATE_COOKIE_NAME));
    headers.append("set-cookie", serializeExpiredNamedCookie(request, SSO_RETURN_TO_COOKIE_NAME));
    return new Response(null, { status: 302, headers });
  }

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
      return apiError("REQUEST_SCHEMA_INVALID", "请输入有效的账号和密码", { requestId });
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
      return apiError("AUTHENTICATION_REQUIRED", "账号或密码错误", { requestId });
    }
    return apiSuccess(
      {
        authenticated: true,
        return_to: returnTo,
        user: {
          account: result.user.account,
          email: result.user.email,
          display_name: result.user.displayName,
        },
      },
      {
        headers: {
          "set-cookie": serializeSessionCookie(request, result.sessionToken, result.expiresAt),
        },
      },
    );
  }

  if (operation === "setup-password") {
    if (method !== "POST") {
      return apiError("REQUEST_SCHEMA_INVALID", "setup-password 只支持 POST", { requestId });
    }
    const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "/";
    if (!isInternalReturnTo(returnTo)) {
      return apiError("REQUEST_SCHEMA_INVALID", "returnTo 必须是站内相对路径", {
        requestId,
      });
    }
    const parsed = passwordSetupSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError("REQUEST_SCHEMA_INVALID", "密码长度需 8-128 个字符，且两次输入必须一致", {
        requestId,
      });
    }
    if (!isPasswordAcceptable(parsed.data.password)) {
      return apiError("PASSWORD_TOO_WEAK", "密码强度不足：请避免常见密码并增加长度或字符种类", {
        requestId,
      });
    }
    try {
      const result = await completePasswordEnrollment({
        headers: request.headers,
        password: parsed.data.password,
      });
      return apiSuccess(
        { authenticated: true, return_to: returnTo },
        {
          headers: {
            "set-cookie": serializeSessionCookie(request, result.sessionToken, result.expiresAt),
          },
        },
      );
    } catch (error) {
      if (!(error instanceof PasswordEnrollmentError)) throw error;
      return apiError("ACCESS_DENIED", "首次设密会话不存在、已失效或账号已完成设密", {
        requestId,
      });
    }
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
  return operation[0] === "login" ||
    operation[0] === "sso" ||
    operation[0] === "callback" ||
    operation[0] === "setup-password" ||
    operation[0] === "logout"
    ? operation[0]
    : null;
}

function isInternalReturnTo(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

function withBasePath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_SNOW_BASE_PATH ?? "";
  if (!basePath || path === basePath || path.startsWith(`${basePath}/`)) return path;
  return `${basePath}${path}`;
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

function serializeExpiredNamedCookie(request: NextRequest, name: string): string {
  return serializeNamedCookie(
    request,
    name,
    "",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0",
  );
}

function serializeFlowCookie(
  request: NextRequest,
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return serializeNamedCookie(request, name, value, `Max-Age=${maxAgeSeconds}`);
}

function serializeCookie(request: NextRequest, value: string, lifetime: string): string {
  return serializeNamedCookie(request, SESSION_COOKIE_NAME, value, lifetime);
}

function serializeNamedCookie(
  request: NextRequest,
  name: string,
  value: string,
  lifetime: string,
): string {
  const basePath = process.env.NEXT_PUBLIC_SNOW_BASE_PATH ?? "";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = request.nextUrl.protocol === "https:" || forwardedProto === "https";
  return [
    `${name}=${value}`,
    `Path=${basePath || "/"}`,
    lifetime,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

function decodeReturnTo(value: string | null): string {
  if (!value) return "/";
  try {
    const decoded = decodeURIComponent(value);
    return isInternalReturnTo(decoded) ? decoded : "/";
  } catch {
    return "/";
  }
}

function equalOpaqueValues(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
