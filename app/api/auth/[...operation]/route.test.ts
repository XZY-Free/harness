import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  name: "test-provider",
  authenticate: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@/lib/identity/identity-extension-bootstrap", () => ({
  getIdentityExtensions: vi.fn(async () => ({ authenticationProvider: provider })),
}));

import { GET, POST } from "@/app/api/auth/[...operation]/route";

describe("auth operation facade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST login 校验账号密码后写入 HttpOnly 会话 cookie", async () => {
    provider.login.mockResolvedValue({
      status: "authenticated",
      sessionToken: "session-token",
      expiresAt: new Date("2026-09-16T00:00:00.000Z"),
      user: { email: "admin@example.com", displayName: "管理员" },
    });
    const request = new NextRequest("https://snow.example.com/api/auth/login?returnTo=/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ADMIN@example.com ", password: "correct horse battery" }),
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      return_to: "/chat",
      user: { email: "admin@example.com", display_name: "管理员" },
    });
    expect(response.headers.get("set-cookie")).toContain("snow_session=session-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(provider.login).toHaveBeenCalledWith({
      email: "admin@example.com",
      password: "correct horse battery",
    });
  });

  it("login 拒绝任意外部 returnTo", async () => {
    const request = new NextRequest(
      "https://snow.example.com/api/auth/login?returnTo=https%3A%2F%2Fevil.example.test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
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
      body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
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
      body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery" }),
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
      body: JSON.stringify({ email: "admin@example.com", password: "wrong password" }),
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("321");
  });

  it("logout 撤销服务端会话并清除 cookie", async () => {
    provider.logout.mockResolvedValue(undefined);
    const request = new NextRequest("https://snow.example.com/api/auth/logout", {
      method: "POST",
      headers: { cookie: "snow_session=session-token" },
    });

    const response = await POST(request, { params: Promise.resolve({ operation: ["logout"] }) });

    expect(response.status).toBe(200);
    expect(provider.logout).toHaveBeenCalledWith({ headers: request.headers });
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
