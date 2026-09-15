import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  name: "test-provider",
  authenticate: vi.fn(),
  login: vi.fn(),
  beginExternalLogin: vi.fn(),
  completeExternalLogin: vi.fn(),
  describeExternalAuth: vi.fn(),
  logout: vi.fn(),
}));

const acceptAuthenticatedEvidence = vi.hoisted(() => vi.fn());
const establishExternalSession = vi.hoisted(() => vi.fn());
const localLogout = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const completePasswordEnrollment = vi.hoisted(() => vi.fn());
const PasswordEnrollmentError = vi.hoisted(
  () =>
    class PasswordEnrollmentError extends Error {
      readonly name = "PasswordEnrollmentError";
    },
);

vi.mock("@/lib/identity/identity-extension-bootstrap", () => ({
  getIdentityExtensions: vi.fn(async () => ({ authenticationProvider: provider })),
}));
vi.mock("@/lib/identity/resolver", () => ({ acceptAuthenticatedEvidence }));
vi.mock("@/lib/identity/local-authentication", () => ({
  SESSION_COOKIE_NAME: "snow_session",
  localAuthenticationProvider: { logout: localLogout },
  establishExternalSession,
  completePasswordEnrollment,
  PasswordEnrollmentError,
}));

import { GET, POST } from "@/app/api/auth/[...operation]/route";

describe("auth operation facade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST login 校验账号密码后写入 HttpOnly 会话 cookie", async () => {
    provider.login.mockResolvedValue({
      status: "authenticated",
      sessionToken: "session-token",
      expiresAt: new Date("2026-09-16T00:00:00.000Z"),
      user: { account: "admin", email: "admin@example.com", displayName: "管理员" },
    });
    const request = new NextRequest("https://snow.example.com/api/auth/login?returnTo=/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: " ADMIN ", password: "correct horse battery" }),
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      return_to: "/chat",
      user: { account: "admin", email: "admin@example.com", display_name: "管理员" },
    });
    expect(response.headers.get("set-cookie")).toContain("snow_session=session-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(provider.login).toHaveBeenCalledWith({
      account: "admin",
      password: "correct horse battery",
    });
  });

  it("login 拒绝任意外部 returnTo", async () => {
    const request = new NextRequest(
      "https://snow.example.com/api/auth/login?returnTo=https%3A%2F%2Fevil.example.test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: "admin", password: "correct horse battery" }),
      },
    );

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(400);
    expect(provider.login).not.toHaveBeenCalled();
  });

  it("浏览器跨站 POST 被拒绝，不能代替用户登录或退出", async () => {
    const request = new NextRequest("https://snow.example.com/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.test",
      },
      body: JSON.stringify({ account: "admin", password: "correct horse battery" }),
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(403);
    expect(provider.login).not.toHaveBeenCalled();
  });

  it("浏览器的 null Origin 同样被拒绝，不能绕过同源校验", async () => {
    const request = new NextRequest("https://snow.example.com/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "null",
      },
      body: JSON.stringify({ account: "admin", password: "correct horse battery" }),
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(403);
    expect(provider.login).not.toHaveBeenCalled();
  });

  it("账号锁定响应提供 Retry-After", async () => {
    provider.login.mockResolvedValue({ status: "rate_limited", retryAfterSeconds: 321 });
    const request = new NextRequest("https://snow.example.com/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://snow.example.com",
      },
      body: JSON.stringify({ account: "admin", password: "wrong password" }),
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("321");
  });

  it("GET sso 生成不可预测 state 并跳转到企业认证入口", async () => {
    provider.beginExternalLogin.mockImplementation(async ({ state }) => ({
      location: `https://sso.example.com/authorize?state=${state}`,
    }));
    const request = new NextRequest("https://snow.example.com/api/auth/sso?returnTo=/chat");

    const response = await GET(request, { params: Promise.resolve({ operation: ["sso"] }) });

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toMatch(/^https:\/\/sso\.example\.com\/authorize\?state=.{32,}$/);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("snow_sso_state=");
    expect(setCookie).toContain("snow_sso_return_to=%2Fchat");
    expect(setCookie).toContain("HttpOnly");
    expect(provider.beginExternalLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: "https://snow.example.com/api/auth/callback",
        returnTo: "/chat",
        state: expect.any(String),
      }),
    );
  });

  it("GET external-methods 返回不含秘密的企业登录入口配置", async () => {
    provider.describeExternalAuth.mockResolvedValue({
      dividerLabel: "或使用企业账号登录",
      methods: [
        {
          id: "enterprise-sso",
          label: "企业统一 SSO",
          icon: "building",
          recommended: true,
          href: "/api/auth/sso?returnTo=%2Fdesktop",
        },
      ],
    });
    const request = new NextRequest(
      "https://snow.example.com/api/auth/external-methods?returnTo=/desktop",
    );

    const response = await GET(request, {
      params: Promise.resolve({ operation: ["external-methods"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      external_auth: {
        dividerLabel: "或使用企业账号登录",
        methods: [
          {
            id: "enterprise-sso",
            label: "企业统一 SSO",
            icon: "building",
            recommended: true,
            href: "/api/auth/sso?returnTo=%2Fdesktop",
          },
        ],
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(provider.describeExternalAuth).toHaveBeenCalledWith({ returnTo: "/desktop" });
  });

  it("external-methods 拒绝外部回跳地址", async () => {
    const request = new NextRequest(
      "https://snow.example.com/api/auth/external-methods?returnTo=https%3A%2F%2Fevil.example.test",
    );

    const response = await GET(request, {
      params: Promise.resolve({ operation: ["external-methods"] }),
    });

    expect(response.status).toBe(400);
    expect(provider.describeExternalAuth).not.toHaveBeenCalled();
  });

  it("callback 在 state 不匹配时拒绝认证且不调用企业提供器", async () => {
    const request = new NextRequest(
      "https://snow.example.com/api/auth/callback?code=oauth-code&state=attacker-state",
      { headers: { cookie: "snow_sso_state=expected-state; snow_sso_return_to=%2Fchat" } },
    );

    const response = await GET(request, { params: Promise.resolve({ operation: ["callback"] }) });

    expect(response.status).toBe(403);
    expect(provider.completeExternalLogin).not.toHaveBeenCalled();
  });

  it("首次企业登录只签发设密会话并跳转到显示账号的设密页", async () => {
    provider.completeExternalLogin.mockResolvedValue({
      status: "authenticated",
      evidence: {
        externalSubject: "enterprise-user-1",
        loginAccount: "zhangsan",
        email: "zhangsan@example.com",
        displayName: "张三",
        trustedAuthenticationClaims: {},
      },
    });
    acceptAuthenticatedEvidence.mockResolvedValue({ userIdentityId: "identity-1" });
    establishExternalSession.mockResolvedValue({
      status: "password_setup_required",
      sessionToken: "setup-token",
      expiresAt: new Date("2026-09-10T10:15:00.000Z"),
    });
    const request = new NextRequest(
      "https://snow.example.com/api/auth/callback?code=oauth-code&state=expected-state",
      { headers: { cookie: "snow_sso_state=expected-state; snow_sso_return_to=%2Fchat" } },
    );

    const response = await GET(request, { params: Promise.resolve({ operation: ["callback"] }) });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://snow.example.com/setup-password?returnTo=%2Fchat",
    );
    expect(response.headers.get("set-cookie")).toContain("snow_session=setup-token");
    expect(establishExternalSession).toHaveBeenCalledWith({
      userIdentityId: "identity-1",
      loginAccount: "zhangsan",
    });
  });

  it("子路径部署时 callback 保留 basePath 进入设密页", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNOW_BASE_PATH", "/snowharness");
    provider.completeExternalLogin.mockResolvedValue({
      status: "authenticated",
      evidence: {
        externalSubject: "enterprise-user-1",
        loginAccount: "zhangsan",
        email: "zhangsan@example.com",
        displayName: "张三",
        trustedAuthenticationClaims: {},
      },
    });
    acceptAuthenticatedEvidence.mockResolvedValue({ userIdentityId: "identity-1" });
    establishExternalSession.mockResolvedValue({
      status: "password_setup_required",
      sessionToken: "setup-token",
      expiresAt: new Date("2026-09-10T10:15:00.000Z"),
    });
    const request = new NextRequest(
      "https://snow.example.com/snowharness/api/auth/callback?code=oauth-code&state=expected-state",
      { headers: { cookie: "snow_sso_state=expected-state; snow_sso_return_to=%2Fchat" } },
    );

    try {
      const response = await GET(request, { params: Promise.resolve({ operation: ["callback"] }) });
      expect(response.headers.get("location")).toBe(
        "https://snow.example.com/snowharness/setup-password?returnTo=%2Fchat",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("首次设密只接受两次一致的密码，并用正式会话替换设密 cookie", async () => {
    completePasswordEnrollment.mockResolvedValue({
      status: "authenticated",
      sessionToken: "authenticated-token",
      expiresAt: new Date("2026-09-17T00:00:00.000Z"),
      user: { account: "zhangsan", email: "zhangsan@example.com", displayName: "张三" },
    });
    const request = new NextRequest(
      "https://snow.example.com/api/auth/setup-password?returnTo=/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "snow_session=setup-token",
          origin: "https://snow.example.com",
        },
        body: JSON.stringify({
          password: "correct horse battery",
          confirmPassword: "correct horse battery",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ operation: ["setup-password"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true, return_to: "/chat" });
    expect(completePasswordEnrollment).toHaveBeenCalledWith({
      headers: request.headers,
      password: "correct horse battery",
    });
    expect(response.headers.get("set-cookie")).toContain("snow_session=authenticated-token");
  });

  it("首次设密拒绝弱密码与超短密码（PASSWORD_TOO_WEAK）", async () => {
    for (const password of ["abc", "abc12345", "password123"]) {
      const request = new NextRequest(
        "https://snow.example.com/api/auth/setup-password?returnTo=/chat",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "snow_session=setup-token",
            origin: "https://snow.example.com",
          },
          body: JSON.stringify({ password, confirmPassword: password }),
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ operation: ["setup-password"] }),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PASSWORD_TOO_WEAK");
    }
    expect(completePasswordEnrollment).not.toHaveBeenCalled();
  });

  it("首次设密拒绝浏览器自报账号以及不一致的确认密码", async () => {
    for (const body of [
      {
        account: "attacker",
        password: "correct horse battery",
        confirmPassword: "correct horse battery",
      },
      { password: "correct horse battery", confirmPassword: "different password" },
    ]) {
      const request = new NextRequest("https://snow.example.com/api/auth/setup-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = await POST(request, {
        params: Promise.resolve({ operation: ["setup-password"] }),
      });
      expect(response.status).toBe(400);
    }
    expect(completePasswordEnrollment).not.toHaveBeenCalled();
  });

  it("首次设密会话失效时返回明确拒绝", async () => {
    completePasswordEnrollment.mockRejectedValue(new PasswordEnrollmentError("会话已失效"));
    const request = new NextRequest("https://snow.example.com/api/auth/setup-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "correct horse battery",
        confirmPassword: "correct horse battery",
      }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ operation: ["setup-password"] }),
    });
    expect(response.status).toBe(403);
  });

  it("首次设密不把数据库故障伪装成会话失效", async () => {
    completePasswordEnrollment.mockRejectedValue(new Error("database unavailable"));
    const request = new NextRequest("https://snow.example.com/api/auth/setup-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "correct horse battery",
        confirmPassword: "correct horse battery",
      }),
    });

    await expect(
      POST(request, { params: Promise.resolve({ operation: ["setup-password"] }) }),
    ).rejects.toThrow("database unavailable");
  });

  it("企业退出失败仍撤销本地会话并清 Cookie", async () => {
    provider.logout.mockRejectedValue(new Error("private upstream secret"));
    const response = await POST(
      new NextRequest("https://snow.example.com/api/auth/logout", { method: "POST" }),
      { params: Promise.resolve({ operation: ["logout"] }) },
    );
    expect(localLogout).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.json()).toEqual({ loggedOut: true, externalLogout: "unavailable" });
  });
  it("返回受信任提供器生成的 HTTPS 退出跳转", async () => {
    provider.logout.mockResolvedValue({ location: "https://id.example.com/logout" });
    const response = await POST(
      new NextRequest("https://snow.example.com/api/auth/logout", { method: "POST" }),
      { params: Promise.resolve({ operation: ["logout"] }) },
    );
    expect(await response.json()).toEqual({
      loggedOut: true,
      redirectTo: "https://id.example.com/logout",
      externalLogout: "redirect",
    });
  });

  it("企业退出超时不阻断本地退出", async () => {
    vi.useFakeTimers();
    try {
      provider.logout.mockImplementationOnce(() => new Promise(() => {}));
      const pending = POST(
        new NextRequest("https://snow.example.com/api/auth/logout", { method: "POST" }),
        { params: Promise.resolve({ operation: ["logout"] }) },
      );
      await vi.advanceTimersByTimeAsync(3001);
      expect(await (await pending).json()).toEqual({
        loggedOut: true,
        externalLogout: "unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("本地撤销失败不能报告成功，也不能调用企业退出", async () => {
    localLogout.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      POST(new NextRequest("https://snow.example.com/api/auth/logout", { method: "POST" }), {
        params: Promise.resolve({ operation: ["logout"] }),
      }),
    ).rejects.toThrow("database unavailable");
    expect(provider.logout).not.toHaveBeenCalled();
  });
  it("拒绝提供器返回的可执行地址", async () => {
    provider.logout.mockResolvedValueOnce({ location: "javascript:alert(1)" });
    const response = await POST(
      new NextRequest("https://snow.example.com/api/auth/logout", { method: "POST" }),
      { params: Promise.resolve({ operation: ["logout"] }) },
    );
    expect(await response.json()).toEqual({ loggedOut: true, externalLogout: "unavailable" });
  });

  it("logout 撤销服务端会话并清除 cookie", async () => {
    provider.logout.mockResolvedValue(undefined);
    const request = new NextRequest("https://snow.example.com/api/auth/logout", {
      method: "POST",
      headers: { cookie: "snow_session=session-token" },
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["logout"] }) });

    expect(response.status).toBe(200);
    expect(provider.logout).toHaveBeenCalledWith({
      headers: request.headers,
      returnToUrl: "https://snow.example.com/login",
    });
    expect(response.headers.get("set-cookie")).toContain("snow_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("未声明的操作不回退到其他认证提供器", async () => {
    const request = new NextRequest("http://localhost/api/auth/refresh");
    const response = await POST(request, { params: Promise.resolve({ operation: ["refresh"] }) });

    expect(response.status).toBe(400);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });
});
