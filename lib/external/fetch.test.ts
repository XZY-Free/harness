import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage B：fetch 域名治理 + 确定性抽取 + artifact 测试。
 *
 * 域名治理 fail-closed（命门 #2）：
 * - 空 allowlist → 全 deny
 * - 域内 → allow
 * - 域外 → deny（批准升级由 Gateway 的 pause 集中处理）
 * - 黑名单 → deny
 * mock node:fs/promises 避免触盘；fetchImpl 注入避免真实网络。
 */

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// url-safety 的 SSRF 守卫（assertSafeExternalUrlResolved）对域名做真实 DNS 解析，
// 使本文件的耗时取决于沙箱对 example.com / evil.com 的解析超时——实测同一用例
// 首次 3024ms、模块热态 58ms，满负载下击穿 5s 默认超时。这里与同目录
// url-safety.test.ts 采用同一模式固定解析结果：安全断言本身仍被真实执行，
// 只是不再依赖外部 DNS。用例可用 mockImplementation 覆盖为内网地址以验证拒绝路径。
const dnsMock = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  resolve4: dnsMock.resolve4,
  resolve6: dnsMock.resolve6,
}));

// 控制域名 allowlist/blacklist（config getter 运行时读 env）
function setEnv(allow: string, black: string) {
  process.env.WEB_FETCH_DOMAIN_ALLOWLIST = allow;
  process.env.WEB_FETCH_DOMAIN_BLACKLIST = black;
}

beforeEach(() => {
  setEnv("", "");
  vi.clearAllMocks();
  // 默认所有域名解析到公网 IP；需要验证拒绝路径的用例自行覆盖。
  dnsMock.resolve4.mockResolvedValue(["93.184.216.34"]);
  dnsMock.resolve6.mockResolvedValue([]);
});

function mockFetch(body: string, opts: { status?: number; contentType?: string } = {}) {
  const status = opts.status ?? 200;
  const contentType = opts.contentType ?? "text/html; charset=utf-8";
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k === "content-type" ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });
}

function mockRedirectFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: { get: (k: string) => (k === "location" ? "https://evil.com/next" : null) },
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === "content-type" ? "text/plain; charset=utf-8" : null) },
      arrayBuffer: async () => new TextEncoder().encode("pwned").buffer,
    });
}

describe("classifyDomain 域名治理 fail-closed", () => {
  it("空 allowlist → 全 deny（配置缺失不变成 allow）", async () => {
    const { classifyDomain } = await import("./fetch");
    setEnv("", "");
    const v = classifyDomain("https://example.com/x");
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("fail-closed");
  });

  it("黑名单命中 → deny（优先于 allowlist）", async () => {
    const { classifyDomain } = await import("./fetch");
    setEnv("example.com", "evil.com");
    expect(classifyDomain("https://evil.com/x").decision).toBe("deny");
    // 黑名单子域也命中
    expect(classifyDomain("https://sub.evil.com/x").decision).toBe("deny");
  });

  it("域内 allowlist 命中 → allow", async () => {
    const { classifyDomain } = await import("./fetch");
    setEnv("example.com", "");
    expect(classifyDomain("https://example.com/x").decision).toBe("allow");
    expect(classifyDomain("https://docs.example.com/x").decision).toBe("allow");
  });

  it("域外（allowlist 非空但未命中）→ deny（批准升级由 Gateway 的 pause 集中处理）", async () => {
    const { classifyDomain } = await import("./fetch");
    setEnv("example.com", "");
    const v = classifyDomain("https://other.com/x");
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("域外");
  });

  it("无效 URL → deny", async () => {
    const { classifyDomain } = await import("./fetch");
    setEnv("example.com", "");
    expect(classifyDomain("not a url").decision).toBe("deny");
  });
});

describe("htmlToText 确定性抽取", () => {
  it("去除 script/style/head，剥标签，解码实体，折叠空白", async () => {
    const { htmlToText } = await import("./fetch");
    const html =
      "<head><title>t</title></head><script>alert(1)</script><style>x{}</style>" +
      "<p>Hello&nbsp;&amp;<b>World</b></p>";
    const text = htmlToText(html);
    expect(text).not.toMatch(/<|alert|title>|style/);
    expect(text).toBe("Hello & World");
  });

  it("非 HTML 原样返回（由调用方决定是否抽取）", async () => {
    const { htmlToText } = await import("./fetch");
    expect(htmlToText("plain text")).toBe("plain text");
  });
});

describe("fetchUrl governance 路由", () => {
  it("域内 → allow → 抓取 + 抽取 + artifact + 来源标记", async () => {
    setEnv("example.com", "");
    const { fetchUrl } = await import("./fetch");
    const fs = await import("node:fs/promises");
    const r = await fetchUrl({
      url: "https://example.com/page",
      threadId: "tid",
      fetchImpl: mockFetch("<html><body><p>Hi there</p></body></html>"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("Hi there");
      expect(r.source.sourceUrl).toBe("https://example.com/page");
      expect(r.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.source.artifactPath).toContain("tid/external/");
      // artifact 原文落盘
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    }
  });

  it("域外 → deny（不抓取）", async () => {
    setEnv("example.com", "");
    const { fetchUrl } = await import("./fetch");
    const fetchImpl = mockFetch("x");
    const r = await fetchUrl({ url: "https://other.com/x", threadId: "tid", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok && "denied" in r) expect(r.denied).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("黑名单 → deny（不抓取）", async () => {
    setEnv("example.com", "evil.com");
    const { fetchUrl } = await import("./fetch");
    const fetchImpl = mockFetch("x");
    const r = await fetchUrl({ url: "https://evil.com/x", threadId: "tid", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok && "denied" in r) expect(r.denied).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("空 allowlist → deny（fail-closed）", async () => {
    setEnv("", "");
    const { fetchUrl } = await import("./fetch");
    const r = await fetchUrl({
      url: "https://example.com/x",
      threadId: "tid",
      fetchImpl: mockFetch("x"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "denied" in r) expect(r.denied).toBe(true);
  });
});

describe("rawFetch 体积/类型/超时", () => {
  it("超过 maxBytes → truncated=true，截断到 maxBytes", async () => {
    setEnv("example.com", "");
    const { rawFetch } = await import("./fetch");
    process.env.WEB_FETCH_MAX_BYTES = "10";
    const big = "A".repeat(100);
    const r = await rawFetch({
      url: "https://example.com/x",
      threadId: "tid",
      fetchImpl: mockFetch(big, { contentType: "text/plain" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.bytes).toBe(10);
    }
    Reflect.deleteProperty(process.env, "WEB_FETCH_MAX_BYTES");
  });

  it("不允许的 Content-Type → error", async () => {
    setEnv("example.com", "");
    const { rawFetch } = await import("./fetch");
    const r = await rawFetch({
      url: "https://example.com/x",
      threadId: "tid",
      fetchImpl: mockFetch("x", { contentType: "application/octet-stream" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Content-Type");
  });

  it("HTTP 非 2xx → error", async () => {
    setEnv("example.com", "");
    const { rawFetch } = await import("./fetch");
    const r = await rawFetch({
      url: "https://example.com/x",
      threadId: "tid",
      fetchImpl: mockFetch("x", { status: 404 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("HTTP 404");
  });

  it("redirect 到 allowlist 外域名 → fail-closed，不继续跟随", async () => {
    setEnv("example.com", "");
    const { rawFetch } = await import("./fetch");
    const fetchImpl = mockRedirectFetch();
    const r = await rawFetch({
      url: "https://example.com/x",
      threadId: "tid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("redirect 目标未通过域名治理");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redirect 目标解析到内网/元数据 IP → fail-closed（生产路径上的 DNS rebinding 守卫）", async () => {
    setEnv("example.com", "");
    const { rawFetch } = await import("./fetch");
    // 入口域名解析到公网（通过 SSRF 入口守卫），redirect 目标解析到云元数据地址。
    dnsMock.resolve4.mockImplementation(async (host: string) =>
      host === "evil.com" ? ["169.254.169.254"] : ["93.184.216.34"],
    );
    const fetchImpl = mockRedirectFetch();
    const r = await rawFetch({
      url: "https://example.com/x",
      threadId: "tid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // DNS 守卫先于域名治理生效：即使目标域名在 allowlist 之外，也必须是"解析到内网"这条
    // 真实理由，而不是被域名匹配顺手挡住。
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("DNS rebinding");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("contentHash 稳定（同内容同 hash）", async () => {
    setEnv("example.com", "");
    const { rawFetch } = await import("./fetch");
    const body = "<html><body>same</body></html>";
    const a = await rawFetch({
      url: "https://example.com/a",
      threadId: "tid",
      fetchImpl: mockFetch(body),
    });
    const b = await rawFetch({
      url: "https://example.com/b",
      threadId: "tid",
      fetchImpl: mockFetch(body),
    });
    if (a.ok && b.ok) expect(a.source.contentHash).toBe(b.source.contentHash);
  });
});
