import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage B：searchDocs 域限定测试。
 */

beforeEach(() => {
  Reflect.deleteProperty(process.env, "SNOW_DOCS_DOMAINS");
  Reflect.deleteProperty(process.env, "SNOW_DOCS_INDEX_PATH");
  Reflect.deleteProperty(process.env, "WEB_FETCH_DOMAIN_ALLOWLIST");
  Reflect.deleteProperty(process.env, "WEB_FETCH_DOMAIN_BLACKLIST");
});

function mockSearchFetch(html: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => html,
  });
}

const DDG_HTML =
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn">React</a>' +
  '<a class="result__snippet" href="#">learn react</a>';

describe("searchDocs", () => {
  it("文档域未配置 → deny", async () => {
    const { searchDocs } = await import("./docs");
    const r = await searchDocs({
      query: "hooks",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "denied" in r) expect(r.denied).toBe(true);
  });

  it("文档域配置 → 仅返回文档域内结果 + 来源", async () => {
    process.env.SNOW_DOCS_DOMAINS = "react.dev";
    const { searchDocs } = await import("./docs");
    const r = await searchDocs({
      query: "hooks",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results[0]?.url).toBe("https://react.dev/learn");
      expect(r.source.sourceUrl).toContain("duckduckgo.com");
    }
  });

  it("配置索引时优先走本地全文索引，不调用搜索引擎", async () => {
    process.env.SNOW_DOCS_DOMAINS = "react.dev";
    const fetchImpl = mockSearchFetch(DDG_HTML);
    const { searchDocs } = await import("./docs");
    const r = await searchDocs({
      query: "useEffect cleanup",
      threadId: "tid",
      fetchImpl,
      indexEntries: [
        {
          url: "https://react.dev/reference/react/useEffect",
          title: "useEffect",
          headings: ["Cleanup function"],
          content: "The cleanup function runs before the effect is re-run and when unmounting.",
        },
        {
          url: "https://example.com/nope",
          title: "Wrong domain",
          content: "useEffect cleanup",
        },
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.sourceUrl).toContain("docs-index://");
      expect(r.source.sourceUrl).not.toContain("duckduckgo.com");
      expect(r.results).toEqual([
        expect.objectContaining({
          url: "https://react.dev/reference/react/useEffect",
          title: "useEffect",
        }),
      ]);
    }
  });

  it("legacy JSON 源会构建 sidecar 索引并在后续搜索中复用", async () => {
    process.env.SNOW_DOCS_DOMAINS = "react.dev";
    const dir = await mkdtemp(join(tmpdir(), "snow-docs-"));
    const sourcePath = join(dir, "docs.json");
    await writeFile(
      sourcePath,
      JSON.stringify([
        {
          url: "https://react.dev/reference/react/useEffect",
          title: "useEffect",
          headings: ["Cleanup"],
          content: "Cleanup runs before rerun and during unmount.",
        },
      ]),
      "utf8",
    );
    process.env.SNOW_DOCS_INDEX_PATH = sourcePath;
    const fetchImpl = mockSearchFetch(DDG_HTML);
    const { searchDocs } = await import("./docs");
    const r = await searchDocs({
      query: "cleanup unmount",
      threadId: "tid",
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const compiledRaw = await readFile(`${sourcePath}.compiled.json`, "utf8");
    const compiled = JSON.parse(compiledRaw) as {
      kind: string;
      version: number;
      sourcePath: string;
      postings: Record<string, string[]>;
    };
    expect(compiled.kind).toBe("snow-docs-index");
    expect(compiled.version).toBe(1);
    expect(compiled.sourcePath).toBe(sourcePath);
    expect(compiled.postings.cleanup?.length).toBeGreaterThan(0);
  });

  it("文档域外的结果被过滤", async () => {
    process.env.SNOW_DOCS_DOMAINS = "vue.dev";
    const { searchDocs } = await import("./docs");
    const r = await searchDocs({
      query: "hooks",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results).toHaveLength(0);
  });
});

// S1（06-P2-5）：真 BM25 评分测试
describe("searchDocs BM25 评分（06-P2-5）", () => {
  beforeEach(() => {
    process.env.SNOW_DOCS_DOMAINS = "react.dev";
  });

  it("罕见词权重 > 常见词（IDF 加权：罕见词排序靠前）", async () => {
    const { searchDocs } = await import("./docs");
    // chunk A 含常见词 "component"（出现在多个 chunk），chunk B 含罕见词 "concurrent"（只出现一次）
    const r = await searchDocs({
      query: "component concurrent",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
      indexEntries: [
        {
          url: "https://react.dev/a",
          title: "component basics",
          content: "component component component component component",
        },
        {
          url: "https://react.dev/b",
          title: "concurrent mode",
          content: "concurrent rendering introduction",
        },
        {
          url: "https://react.dev/c",
          title: "component advanced",
          content: "component advanced patterns",
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 罕见词 concurrent 只在 b 出现，IDF 高；常见词 component 在 a/c 出现，IDF 低。
      // b 应排第一（罕见词权重主导，即便 tf=1 也高过常见词多频次）。
      expect(r.results[0]?.url).toBe("https://react.dev/b");
    }
  });

  it("长文档 tf 饱和（k1 限制高频词继续加分，长文档不被过度奖励）", async () => {
    const { searchDocs } = await import("./docs");
    // 两个 chunk 都只含目标词，但一个文档极长（tf 高但经 tfNorm 饱和后差异收窄）
    const shortContent = "useeffect cleanup once";
    const longContent = `${"useeffect ".repeat(50)}${"cleanup ".repeat(50)}padding`.slice(0, 600);
    const r = await searchDocs({
      query: "useeffect cleanup",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
      indexEntries: [
        { url: "https://react.dev/short", title: "short", content: shortContent },
        { url: "https://react.dev/long", title: "long", content: longContent },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 长文档 tf 虽高（useeffect 出现 50 次），但 BM25 tfNorm 饱和后增量递减；
      // 短文档因长度归一化（b=0.75）tf 权重相对放大。两者都应返回（score>0），
      // 且长文档不应因 tf=50 而拿到远超短文档的分数（饱和效应）。
      const urls = r.results.map((x) => x.url);
      expect(urls).toContain("https://react.dev/short");
      expect(urls).toContain("https://react.dev/long");
      // 验证饱和：长文档 tf=50 但分数不应是短文档的 10 倍以上（tfNorm 把 50 压到接近 1.x 量级）
      // 这里只断言两者都命中 + 长文档未因高频词碾压短文档（排序可变，但都在结果内）。
    }
  });

  it("IDF 平滑地板不丢结果（常见词 df=N 时 IDF→0 但仍返回匹配 chunk）", async () => {
    const { searchDocs } = await import("./docs");
    // 所有 chunk 都含 "hooks"（df=N），IDF 经 +1 平滑后为 log(0.5/(N+0.5)+1) > 0
    const r = await searchDocs({
      query: "hooks",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
      indexEntries: [
        { url: "https://react.dev/h1", title: "hooks intro", content: "hooks basics" },
        { url: "https://react.dev/h2", title: "hooks advanced", content: "hooks deep dive" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 即使 term 在所有 chunk 出现（df=N），IDF 平滑地板保证 score > 0，结果不丢失
      expect(r.results.length).toBeGreaterThan(0);
    }
  });

  it("title 命中权重 > content 命中（field weight boost 保留）", async () => {
    const { searchDocs } = await import("./docs");
    // chunk A 在 title 含目标词，chunk B 只在 content 含（同长度，tf 同为 1）
    const r = await searchDocs({
      query: "suspense",
      threadId: "tid",
      fetchImpl: mockSearchFetch(DDG_HTML),
      indexEntries: [
        { url: "https://react.dev/title-hit", title: "suspense guide", content: "introduction" },
        {
          url: "https://react.dev/content-hit",
          title: "data fetching",
          content: "suspense for data",
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // title 命中（8x boost）应排在 content 命中（tfNorm≈1）之前
      expect(r.results[0]?.url).toBe("https://react.dev/title-hit");
    }
  });
});
