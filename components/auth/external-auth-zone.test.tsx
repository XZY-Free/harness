import type { ExternalAuthZoneConfig } from "@/lib/identity/authentication-provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalAuthZone } from "./external-auth-zone";

vi.mock("@/lib/api-fetch", () => ({ apiPath: (path: string) => `/base${path}` }));

afterEach(() => cleanup());

function method(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { id, label, href: `/api/auth/sso?returnTo=%2Fchat&via=${id}`, ...extra };
}

function config(methods: ReturnType<typeof method>[], extra: Record<string, unknown> = {}) {
  return { dividerLabel: "或使用企业账号登录", methods, ...extra } as ExternalAuthZoneConfig;
}

describe("ExternalAuthZone", () => {
  it("单个认证方式 auto 解析为带图标的完整长按钮", () => {
    render(
      <ExternalAuthZone
        config={config([method("sso", "集团统一 SSO", { icon: "building", recommended: true })])}
      />,
    );

    const link = screen.getByRole("link", { name: /集团统一 SSO/ });
    expect(link.getAttribute("href")).toBe("/base/api/auth/sso?returnTo=%2Fchat&via=sso");
    expect(link.className).toContain("w-full");
    expect(link.className).toContain("h-11");
    expect(link.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("或使用企业账号登录")).toBeTruthy();
  });

  it("3 个认证方式 auto 解析为等宽图标卡片且图标与文字成对", () => {
    render(
      <ExternalAuthZone
        config={config([
          method("sso", "集团统一 SSO", { icon: "building" }),
          method("wecom", "企业微信", { icon: "chat" }),
          method("mail", "邮箱验证码", { icon: "mail" }),
        ])}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.className).not.toContain("w-full");
      expect(link.querySelector("svg")).toBeTruthy();
    }
    const wrapper = links[0]?.parentElement;
    expect(wrapper?.className).toContain("auto-fit");
    expect(screen.getByText("集团统一 SSO")).toBeTruthy();
    expect(screen.getByText("企业微信")).toBeTruthy();
    expect(screen.getByText("邮箱验证码")).toBeTruthy();
  });

  it("6 个认证方式 auto 解析为紧凑列表行", () => {
    render(
      <ExternalAuthZone
        config={config([
          method("a", "集团统一 SSO", { icon: "building" }),
          method("b", "子公司 SSO", { icon: "network" }),
          method("c", "企业微信", { icon: "chat" }),
          method("d", "邮箱验证码", { icon: "mail" }),
          method("e", "手机号", { icon: "phone" }),
          method("f", "合作伙伴通道"),
        ])}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(6);
    for (const link of links) {
      expect(link.className).toContain("h-12");
    }
    const wrapper = links[0]?.parentElement;
    expect(wrapper?.className).toContain("flex-col");
  });

  it("displayMode 可覆盖 auto 解析", () => {
    const three = [
      method("sso", "集团统一 SSO", { icon: "building" }),
      method("wecom", "企业微信", { icon: "chat" }),
      method("mail", "邮箱验证码", { icon: "mail" }),
    ];
    const first = render(<ExternalAuthZone config={config(three, { displayMode: "stacked" })} />);
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("h-12");
    }
    first.unmount();

    const second = render(
      <ExternalAuthZone
        config={config(
          [
            ...three,
            method("d", "邮箱验证码备份", { icon: "mail" }),
            method("e", "手机号", { icon: "phone" }),
            method("f", "合作伙伴通道"),
          ],
          { displayMode: "button" },
        )}
      />,
    );
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("w-full");
      expect(link.className).toContain("h-11");
    }
    second.unmount();
  });

  it("图标缺失时回退名称首字且仍保留完整文字", () => {
    render(<ExternalAuthZone config={config([method("partner", "合作伙伴通道")])} />);

    const link = screen.getByRole("link", { name: /合作伙伴通道/ });
    expect(link.textContent).toContain("合作伙伴通道");
    expect(link.textContent).toContain("合");
    expect(link.querySelector("svg")).toBeNull();
  });

  it("推荐标记来自配置且仅标记配置项", () => {
    render(
      <ExternalAuthZone
        config={config([
          method("sso", "集团统一 SSO", { icon: "building", recommended: true }),
          method("mail", "邮箱验证码", { icon: "mail" }),
        ])}
      />,
    );

    expect(screen.getAllByText("推荐")).toHaveLength(1);
    const recommended = screen.getByRole("link", { name: /集团统一 SSO/ });
    expect(recommended.textContent).toContain("推荐");
    const plain = screen.getByRole("link", { name: /邮箱验证码/ });
    expect(plain.textContent).not.toContain("推荐");
  });

  it("分隔线文案来自配置且焦点态显式", () => {
    render(
      <ExternalAuthZone
        config={config([method("sso", "集团统一 SSO", { icon: "building" })], {
          dividerLabel: "或使用其他方式登录",
        })}
      />,
    );

    expect(screen.getByText("或使用其他方式登录")).toBeTruthy();
    expect(screen.queryByText("或使用企业账号登录")).toBeNull();
    const link = screen.getByRole("link", { name: /集团统一 SSO/ });
    expect(link.className).toContain("focus-visible:");
  });
});
