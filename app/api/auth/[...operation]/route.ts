import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import type { AuthenticationResult } from "@/lib/identity/authentication-provider";
import { getIdentityExtensions } from "@/lib/identity/identity-extension-bootstrap";
import type { NextRequest } from "next/server";

type AuthOperation = "login" | "callback" | "logout";
type AuthRouteContext = { params: Promise<{ operation?: string[] }> };

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

  const { authenticationProvider } = await getIdentityExtensions();
  if (operation === "login") {
    if (method !== "GET") {
      return apiError("REQUEST_SCHEMA_INVALID", "login 只支持 GET", { requestId });
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
    const redirect = await authenticationProvider.login({ returnTo });
    return new Response(null, { status: 302, headers: { location: redirect.location } });
  }

  if (operation === "callback") {
    if (!authenticationProvider.callback) {
      return apiError("FEATURE_NOT_READY", "当前认证提供器未声明 callback 操作", {
        requestId,
      });
    }
    const result = await authenticationProvider.callback(request);
    return authenticationResultResponse(result, requestId);
  }

  if (method !== "POST") {
    return apiError("REQUEST_SCHEMA_INVALID", "logout 只支持 POST", { requestId });
  }
  if (!authenticationProvider.logout) {
    return apiError("FEATURE_NOT_READY", "当前认证提供器未声明 logout 操作", {
      requestId,
    });
  }
  const redirect = await authenticationProvider.logout({ headers: request.headers });
  return redirect
    ? new Response(null, { status: 302, headers: { location: redirect.location } })
    : apiSuccess({ loggedOut: true });
}

async function readOperation(context: AuthRouteContext): Promise<AuthOperation | null> {
  const operation = (await context.params).operation;
  if (operation?.length !== 1) return null;
  return operation[0] === "login" || operation[0] === "callback" || operation[0] === "logout"
    ? operation[0]
    : null;
}

function isInternalReturnTo(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

function authenticationResultResponse(result: AuthenticationResult, requestId: string): Response {
  if (result.status === "authenticated") {
    return apiSuccess({
      authenticated: true,
      user: {
        externalSubject: result.evidence.externalSubject,
        email: result.evidence.email,
        displayName: result.evidence.displayName,
      },
    });
  }
  if (result.status === "denied") {
    return apiError("ACCESS_DENIED", result.reason, { requestId });
  }
  return apiError("AUTHENTICATION_REQUIRED", "认证未完成", { requestId });
}
