import { isInternalHost } from "@/lib/external/url-safety";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeScript, executeWebhook, parseDeclaration } from "./registry";

/**
 * V3.4 Stage D：自定义工具声明校验 + webhook 域名治理/SSRF + script 白名单测试。
 */

function setEnv(allow: string, black: string) {
  process.env.WEB_FETCH_DOMAIN_ALLOWLIST = allow;
  process.env.WEB_FETCH_DOMAIN_BLACKLIST = black;
}

beforeEach(() => {
  setEnv("", "");
});

describe("parseDeclaration 声明校验", () => {
  it("合法 webhook 声明 → ok", () => {
    const r = parseDeclaration({
      name: "deploy",
      description: "部署",
      inputSchema: { type: "object", properties: { env: { type: "string" } } },
      executorType: "webhook",
      executorConfig: { url: "https://example.com/hook", method: "POST" },
    });
    expect(r.ok).toBe(true);
  });

  it("合法 script 声明（白名单 scriptId）→ ok", () => {
    const r = parseDeclaration({
      name: "echoTool",
      description: "echo",
      inputSchema: { type: "object" },
      executorType: "script",
      executorConfig: { scriptId: "echo" },
    });
    expect(r.ok).toBe(true);
  });

  it("非法 name（数字开头）→ 拒绝", () => {
    const r = parseDeclaration({
      name: "1bad",
      description: "x",
      inputSchema: { type: "object" },
      executorType: "script",
      executorConfig: { scriptId: "echo" },
    });
    expect(r.ok).toBe(false);
  });

  it("非法 inputSchema（非 object type）→ 拒绝", () => {
    const r = parseDeclaration({
      name: "ok",
      description: "x",
      inputSchema: { type: "string" },
      executorType: "script",
      executorConfig: { scriptId: "echo" },
    });
    expect(r.ok).toBe(false);
  });

  it("非白名单 scriptId → 拒绝（命门：不执行任意脚本）", () => {
    const r = parseDeclaration({
      name: "evil",
      description: "x",
      inputSchema: { type: "object" },
      executorType: "script",
      executorConfig: { scriptId: "rm-rf" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("白名单");
  });

  it("非法 webhook method → 拒绝", () => {
    const r = parseDeclaration({
      name: "ok",
      description: "x",
      inputSchema: { type: "object" },
      executorType: "webhook",
      executorConfig: { url: "https://example.com/h", method: "TRACE" },
    });
    expect(r.ok).toBe(false);
  });
});

describe("isInternalHost SSRF 防护", () => {
  it("内网/环回/元数据地址命中", async () => {
    expect(isInternalHost("127.0.0.1")).toBe(true);
    expect(isInternalHost("10.0.0.1")).toBe(true);
    expect(isInternalHost("192.168.1.1")).toBe(true);
    expect(isInternalHost("169.254.169.254")).toBe(true);
    expect(isInternalHost("172.16.0.1")).toBe(true);
    expect(isInternalHost("localhost")).toBe(true);
    expect(isInternalHost("::1")).toBe(true);
  });

  it("公网地址不命中", async () => {
    expect(isInternalHost("example.com")).toBe(false);
    expect(isInternalHost("8.8.8.8")).toBe(false);
  });
});

describe("executeWebhook 域名治理 + SSRF", () => {
  function mockFetch(body = "ok", status = 200) {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    });
  }

  function mockRedirectFetch() {
    return vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: { get: (k: string) => (k === "location" ? "https://evil.com/hook" : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "pwned",
      });
  }

  it("域内 allowlist → 调用成功", async () => {
    setEnv("example.com", "");
    const r = await executeWebhook(
      { url: "https://example.com/hook", method: "POST" },
      { x: 1 },
      mockFetch(),
    );
    expect(r.ok).toBe(true);
  });

  it("内网地址 → 拒绝（SSRF）", async () => {
    setEnv("example.com", "");
    const fetchImpl = mockFetch();
    const r = await executeWebhook(
      { url: "http://169.254.169.254/latest/meta-data", method: "GET" },
      {},
      fetchImpl,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("内网/元数据");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("域外（未在 allowlist）→ 拒绝", async () => {
    setEnv("example.com", "");
    const fetchImpl = mockFetch();
    const r = await executeWebhook(
      { url: "https://other.com/hook", method: "POST" },
      {},
      fetchImpl,
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("空 allowlist → 拒绝（fail-closed）", async () => {
    setEnv("", "");
    const r = await executeWebhook(
      { url: "https://example.com/hook", method: "POST" },
      {},
      mockFetch(),
    );
    expect(r.ok).toBe(false);
  });

  it("HTTP 非 2xx → error", async () => {
    setEnv("example.com", "");
    const r = await executeWebhook(
      { url: "https://example.com/hook", method: "POST" },
      {},
      mockFetch("err", 500),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("webhook HTTP 500");
  });

  it("redirect 到 allowlist 外域名 → fail-closed，不继续跟随", async () => {
    setEnv("example.com", "");
    const fetchImpl = mockRedirectFetch();
    const r = await executeWebhook(
      { url: "https://example.com/hook", method: "POST" },
      {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("redirect 域名未在 allowlist");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // S1 修复（01-P2-6）：webhook 自定义 headers 白名单过滤
  it("敏感 header（authorization/cookie/x-api-key）被剔除，content-type 强制 application/json", async () => {
    setEnv("example.com", "");
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi
      .fn()
      .mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, status: 200, text: async () => "ok" });
      });
    const r = await executeWebhook(
      {
        url: "https://example.com/hook",
        method: "POST",
        headers: {
          Authorization: "Bearer evil",
          Cookie: "session=1",
          "X-API-Key": "secret",
          "X-Custom": "keep-me",
          "Content-Type": "text/plain",
        },
      },
      {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(capturedHeaders["content-type"]).toBe("application/json");
    expect(capturedHeaders["Content-Type"]).toBeUndefined();
    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(capturedHeaders.Cookie).toBeUndefined();
    expect(capturedHeaders["X-API-Key"]).toBeUndefined();
    expect(capturedHeaders["X-Custom"]).toBe("keep-me");
  });
});

describe("executeScript 白名单", () => {
  it("白名单 echo → 执行回显", async () => {
    const r = await executeScript("echo", { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toEqual({ a: 1 });
  });

  it("非白名单 scriptId → 拒绝（命门）", async () => {
    const r = await executeScript("rm-rf", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("白名单");
  });
});
