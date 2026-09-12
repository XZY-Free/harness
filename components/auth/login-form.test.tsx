import { DEFAULT_BRAND } from "@/lib/branding/brand-contract";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";
import { LoginScreen } from "./login-screen";
import { PasswordSetupScreen } from "./password-setup-screen";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ apiFetch, apiPath: (path: string) => path }));

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

    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: " Admin " },
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
        account: "Admin",
        password: "correct horse battery staple",
      }),
    });
  });

  it("登录失败只展示通用错误且允许再次提交", async () => {
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "账号或密码错误" } }), { status: 401 }),
    );
    render(<LoginForm returnTo="/chat" onAuthenticated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong password" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect((await screen.findByRole("alert")).textContent).toBe("账号或密码错误");
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("LoginScreen", () => {
  it("用左右分栏组织品牌与表单，不再显示独立登录标题", () => {
    render(<LoginScreen />);

    expect(screen.getAllByText(DEFAULT_BRAND.name)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "登录" })).toBeNull();
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
    const loginRegion = screen.getByLabelText(`${DEFAULT_BRAND.name} 登录`);
    expect(loginRegion.querySelector("img")).toBeNull();
    expect(loginRegion.className).toContain("md:grid-cols-2");
    expect(loginRegion.querySelector("form")?.parentElement?.className).toContain("max-w-[28rem]");
    expect(screen.queryByText(/管理员/)).toBeNull();
    expect(screen.queryByText(/账号由/)).toBeNull();
  });

  it("认证提供器启用外部登录时将认证区沉底于登录按钮之后", () => {
    render(
      <LoginScreen
        returnTo="/chat"
        externalAuth={{
          dividerLabel: "或使用企业账号登录",
          methods: [
            {
              id: "sso",
              label: "集团统一 SSO",
              icon: "building",
              recommended: true,
              href: "/api/auth/sso?returnTo=%2Fchat",
            },
          ],
        }}
      />,
    );

    const link = screen.getByRole("link", { name: /集团统一 SSO/ });
    const submit = screen.getByRole("button", { name: "登录" });
    const password = screen.getByLabelText("密码");
    const controls = Array.from(
      screen.getByLabelText(`${DEFAULT_BRAND.name} 登录`).querySelectorAll("input, a, button"),
    );
    expect(link.getAttribute("href")).toBe("/api/auth/sso?returnTo=%2Fchat");
    expect(controls.indexOf(password)).toBeLessThan(controls.indexOf(submit));
    expect(controls.indexOf(submit)).toBeLessThan(controls.indexOf(link));
    expect(screen.getByText("或使用企业账号登录")).toBeTruthy();
  });

  it("未配置外部认证时不渲染认证区与分隔线", () => {
    render(<LoginScreen returnTo="/chat" />);

    expect(screen.queryByText(/或使用/)).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("PasswordSetupScreen", () => {
  it("只读展示企业账号，提交体只包含两次密码", async () => {
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, return_to: "/chat" }), { status: 200 }),
    );
    const onAuthenticated = vi.fn();
    render(
      <PasswordSetupScreen
        account="zhangsan"
        displayName="张三"
        returnTo="/chat"
        onAuthenticated={onAuthenticated}
      />,
    );

    const account = screen.getByLabelText("账号") as HTMLInputElement;
    expect(account.value).toBe("zhangsan");
    expect(account.readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText("设置密码"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: `保存并进入 ${DEFAULT_BRAND.name}` }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith("/chat"));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/setup-password?returnTo=%2Fchat", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "correct horse battery",
        confirmPassword: "correct horse battery",
      }),
    });
  });

  it("两次密码不一致时在浏览器内阻止提交", async () => {
    render(<PasswordSetupScreen account="zhangsan" returnTo="/chat" />);
    fireEvent.change(screen.getByLabelText("设置密码"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "different password" },
    });
    fireEvent.click(screen.getByRole("button", { name: `保存并进入 ${DEFAULT_BRAND.name}` }));

    expect((await screen.findByRole("alert")).textContent).toBe("两次输入的密码不一致");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
