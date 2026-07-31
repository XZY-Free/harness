import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage B：webSearch 结构化结果 + 域名过滤测试。
 */

function setEnv(allow: string, black: string) {
  process.env.WEB_FETCH_DOMAIN_ALLOWLIST = allow;
  process.env.WEB_FETCH_DOMAIN_BLACKLIST = black;
}

beforeEach(() => {
  setEnv("", "");
});

function mockSearchFetch(html: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => html,
  });
}

const DDG_HTML = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn&rut=1">React Docs</a>
<a class="result__snippet" href="#">React is a JS library</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fevil.com%2Fx&rut=1">Evil</a>
<a class="result__snippet" href="#">bad</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvue.dev%2Fguide&rut=1">Vue Guide</a>
<a class="result__snippet" href="#">Vue framework</a>
`;

describe("parseDuckDuckGo 域名过滤", () => {
  it("仅返回 allowlist 域内结果，黑名单排除", async () => {
    const { parseDuckDuckGo } = await import("./search");
    const results = parseDuckDuckGo(DDG_HTML, ["react.dev", "vue.dev"], ["evil.com"], 8);
    const urls = results.map((r) => r.url);
    expect(urls).toContain("https://react.dev/learn");
    expect(urls).toContain("https://vue.dev/guide");
    expect(urls).not.toContain("https://evil.com/x");
  });

  it("maxResults 截断", async () => {
    const { parseDuckDuckGo } = await import("./search");
    const results = parseDuckDuckGo(DDG_HTML, ["react.dev", "vue.dev"], [], 1);
    expect(results).toHaveLength(1);
  });

  it("结果带 title + snippet", async () => {
    const { parseDuckDuckGo } = await import("./search");
    const results = parseDuckDuckGo(DDG_HTML, ["react.dev"], [], 8);
    expect(results[0]?.title).toBe("React Docs");
    expect(results[0]?.snippet).toBe("React is a JS library");
  });
});

describe("webSearch 治理 + 来源", () => {
  it("空 allowlist → deny（fail-closed）", async () => {
    setEnv("", "");
    const { webSearch } = await import("./search");
    const r = await webSearch({
      query: "q",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "denied" in r) expect(r.denied).toBe(true);
  });

  it("allowlist 非空 → 返回结构化结果 + 来源标记", async () => {
    setEnv("react.dev,vue.dev", "");
    const { webSearch } = await import("./search");
    const r = await webSearch({
      query: "react",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results.length).toBe(2);
      expect(r.source.sourceUrl).toContain("duckduckgo.com");
      expect(r.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("黑名单含 duckduckgo.com → deny", async () => {
    setEnv("react.dev", "duckduckgo.com");
    const { webSearch } = await import("./search");
    const r = await webSearch({
      query: "q",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "denied" in r) expect(r.denied).toBe(true);
  });
});
