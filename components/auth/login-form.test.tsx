import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";
import { LoginScreen } from "./login-screen";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ apiFetch }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LoginForm", () => {
  it("提交账号密码并在认证成功后进入原页面", async () => {
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, return_to: "/chat" }), { status: 200 }),
    );
    const onAuthenticated = vi.fn();
    render(<LoginForm returnTo="/chat" onAuthenticated={onAuthenticated} />);

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: " Admin@Example.com " },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith("/chat"));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/login?returnTo=%2Fchat", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "Admin@Example.com",
        password: "correct horse battery staple",
      }),
    });
  });

  it("登录失败只展示通用错误且允许再次提交", async () => {
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "邮箱或密码错误" } }), { status: 401 }),
    );
    render(<LoginForm returnTo="/chat" onAuthenticated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect((await screen.findByRole("alert")).textContent).toBe("邮箱或密码错误");
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("LoginScreen", () => {
  it("只保留一次产品名和直接的登录标题，不展示管理员或账号创建说明", () => {
    render(<LoginScreen />);

    expect(screen.getAllByText("SnowHarness")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
    expect(screen.queryByText(/管理员/)).toBeNull();
    expect(screen.queryByText(/账号由/)).toBeNull();
  });
});
