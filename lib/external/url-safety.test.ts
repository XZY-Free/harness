import { afterEach, describe, expect, it, vi } from "vitest";

// mock DNS 解析,测 DNS rebinding 防护(不连真实 DNS)
const dnsMock = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  resolve4: dnsMock.resolve4,
  resolve6: dnsMock.resolve6,
}));

import {
  assertSafeExternalUrl,
  assertSafeExternalUrlResolved,
  assertSafeGitRemoteUrl,
  isInternalHost,
  isSafeExternalUrl,
  isSafeGitRemoteUrl,
} from "./url-safety";

describe("url-safety SSRF 防护", () => {
  it("isInternalHost 识别内网/元数据", () => {
    expect(isInternalHost("127.0.0.1")).toBe(true);
    expect(isInternalHost("10.0.0.1")).toBe(true);
    expect(isInternalHost("192.168.1.1")).toBe(true);
    expect(isInternalHost("169.254.169.254")).toBe(true);
    expect(isInternalHost("172.16.0.1")).toBe(true);
    expect(isInternalHost("localhost")).toBe(true);
    expect(isInternalHost("::1")).toBe(true);
    expect(isInternalHost("example.com")).toBe(false);
  });

  it("isSafeExternalUrl 拒绝非 http/https 协议", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("gopher://x/")).toBe(false);
    expect(isSafeExternalUrl("data:text/plain,x")).toBe(false);
  });

  it("isSafeExternalUrl 拒绝内网/元数据 URL", () => {
    expect(isSafeExternalUrl("http://127.0.0.1/")).toBe(false);
    expect(isSafeExternalUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeExternalUrl("http://localhost:8080/")).toBe(false);
  });

  it("isSafeExternalUrl 接受合法公网 https", () => {
    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
  });

  it("isSafeExternalUrl 拒绝 nip.io 内网前缀绕过", () => {
    expect(isSafeExternalUrl("http://127.0.0.1.nip.io/")).toBe(false);
    expect(isSafeExternalUrl("http://10.0.0.1.nip.io/")).toBe(false);
  });

  it("assertSafeExternalUrl 不安全时抛错", () => {
    expect(() => assertSafeExternalUrl("http://169.254.169.254/")).toThrow();
    expect(() => assertSafeExternalUrl("https://example.com/")).not.toThrow();
  });

  it("isSafeGitRemoteUrl 接受 https / SCP / ssh 合法形态", () => {
    expect(isSafeGitRemoteUrl("https://github.com/user/repo.git")).toBe(true);
    expect(isSafeGitRemoteUrl("https://x:token@github.com/user/repo.git")).toBe(true);
    expect(isSafeGitRemoteUrl("git@github.com:user/repo.git")).toBe(true);
    expect(isSafeGitRemoteUrl("ssh://git@github.com/user/repo.git")).toBe(true);
  });

  it("isSafeGitRemoteUrl 拒绝 file:// / 内网 / 元数据", () => {
    expect(isSafeGitRemoteUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeGitRemoteUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeGitRemoteUrl("https://10.0.0.1/x")).toBe(false);
    expect(isSafeGitRemoteUrl("git@127.0.0.1:x/repo.git")).toBe(false);
    expect(isSafeGitRemoteUrl("ssh://git@localhost/x")).toBe(false);
    expect(isSafeGitRemoteUrl("gopher://x/")).toBe(false);
  });

  it("assertSafeGitRemoteUrl 不安全时抛错", () => {
    expect(() => assertSafeGitRemoteUrl("file:///etc/passwd")).toThrow();
    expect(() => assertSafeGitRemoteUrl("http://169.254.169.254/")).toThrow();
    expect(() => assertSafeGitRemoteUrl("https://github.com/u/r.git")).not.toThrow();
    expect(() => assertSafeGitRemoteUrl("git@github.com:u/r.git")).not.toThrow();
  });
});

describe("assertSafeExternalUrlResolved DNS rebinding 防护", () => {
  afterEach(() => {
    dnsMock.resolve4.mockReset();
    dnsMock.resolve6.mockReset();
  });

  it("域名解析到内网/元数据 IP → 拒(防 DNS rebinding)", async () => {
    dnsMock.resolve4.mockResolvedValue(["169.254.169.254"]);
    dnsMock.resolve6.mockResolvedValue([]);
    await expect(
      assertSafeExternalUrlResolved("https://evil.example.com/", "test"),
    ).rejects.toThrow(/DNS rebinding/);
  });

  it("域名解析到 127.0.0.1 → 拒", async () => {
    dnsMock.resolve4.mockResolvedValue(["127.0.0.1"]);
    dnsMock.resolve6.mockResolvedValue([]);
    await expect(
      assertSafeExternalUrlResolved("https://evil.example.com/", "test"),
    ).rejects.toThrow(/内网\/元数据/);
  });

  it("域名解析到公网 IP → 放行", async () => {
    dnsMock.resolve4.mockResolvedValue(["93.184.216.34"]);
    dnsMock.resolve6.mockResolvedValue([]);
    await expect(
      assertSafeExternalUrlResolved("https://example.com/", "test"),
    ).resolves.toBeUndefined();
  });

  it("IPv6 解析到内网 → 拒", async () => {
    dnsMock.resolve4.mockResolvedValue([]);
    dnsMock.resolve6.mockResolvedValue(["::1"]);
    await expect(
      assertSafeExternalUrlResolved("https://evil.example.com/", "test"),
    ).rejects.toThrow(/DNS rebinding/);
  });

  it("IP 字面量 URL 不走 DNS(已由字面量校验覆盖)", async () => {
    // 169.254.169.254 是 IP 字面量,字面量校验直接拒,不触发 resolve
    await expect(
      assertSafeExternalUrlResolved("https://169.254.169.254/", "test"),
    ).rejects.toThrow();
    expect(dnsMock.resolve4).not.toHaveBeenCalled();
  });

  it("DNS 解析失败(NXDOMAIN)→ 不阻断,交由后续 fetch 失败", async () => {
    dnsMock.resolve4.mockRejectedValue(new Error("ENOTFOUND"));
    dnsMock.resolve6.mockRejectedValue(new Error("ENOTFOUND"));
    // 字面量校验通过 + DNS 无结果 → 不抛(域名形式上合法)
    await expect(
      assertSafeExternalUrlResolved("https://unresolvable.example.com/", "test"),
    ).resolves.toBeUndefined();
  });
});
