import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  name: "test-provider",
  authenticate: vi.fn(),
  login: vi.fn(),
  callback: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@/lib/identity/identity-extension-bootstrap", () => ({
  getIdentityExtensions: vi.fn(async () => ({ authenticationProvider: provider })),
}));

import { GET, POST } from "@/app/api/auth/[...operation]/route";

describe("auth operation facade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("只接受站内相对 returnTo，并交给当前提供器发起登录", async () => {
    provider.login.mockResolvedValue({ location: "https://sso.example.test/login" });
    const request = new NextRequest("http://localhost/api/auth/login?returnTo=/threads/1");

    const response = await GET(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sso.example.test/login");
    expect(provider.login).toHaveBeenCalledWith({ returnTo: "/threads/1" });
  });

  it("拒绝任意外部跳转", async () => {
    const request = new NextRequest(
      "http://localhost/api/auth/login?returnTo=https%3A%2F%2Fevil.example.test",
    );

    const response = await GET(request, { params: Promise.resolve({ operation: ["login"] }) });

    expect(response.status).toBe(400);
    expect(provider.login).not.toHaveBeenCalled();
  });

  it("未声明的操作不回退到其他认证提供器", async () => {
    const request = new NextRequest("http://localhost/api/auth/refresh");
    const response = await POST(request, { params: Promise.resolve({ operation: ["refresh"] }) });

    expect(response.status).toBe(400);
    expect(provider.authenticate).not.toHaveBeenCalled();
  });
});
