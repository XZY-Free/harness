import { computeArgFingerprint } from "@/lib/permission/approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.4 Stage B：web 工具经 executeToolRun + 域名治理测试。
 *
 * 用真实 executeToolRun + 真实 domainEvaluate（域名治理路由）+ mock DB queries，
 * mock rawFetch/webSearch/searchDocs 避免真实网络/磁盘。
 * 验收（命门 #2）：
 * - 域内 → allow → 跑 runner + external.fetched 事件 + 来源标记
 * - 域外 → ask → awaitingApproval（executeToolRun 创建审批 + 暂停）
 * - 黑名单 → deny → fail-closed
 * - 空 allowlist → deny
 */

const TID = "test-web-tools";

const queryMocks = vi.hoisted(() => ({
  createToolRun: vi.fn(),
  appendThreadEvent: vi.fn(),
  finishToolRunSuccess: vi.fn(),
  finishToolRunFailure: vi.fn(),
  listPermissionRules: vi.fn(),
  findMatchingApprovals: vi.fn(),
  consumeOnceApproval: vi.fn(),
  requestApprovalAtomic: vi.fn(),
  updateThreadStatus: vi.fn(),
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({
  updateThreadStatus: queryMocks.updateThreadStatus,
  createToolRun: queryMocks.createToolRun,
  appendThreadEvent: queryMocks.appendThreadEvent,
  finishToolRunSuccess: queryMocks.finishToolRunSuccess,
  finishToolRunFailure: queryMocks.finishToolRunFailure,
  listPermissionRules: queryMocks.listPermissionRules,
  findMatchingApprovals: queryMocks.findMatchingApprovals,
  consumeOnceApproval: queryMocks.consumeOnceApproval,
  requestApprovalAtomic: queryMocks.requestApprovalAtomic,
}));

// 保留真实 domainEvaluate（治理路由），仅 mock rawFetch 避免网络/磁盘
const fetchMod = vi.hoisted(() => ({ rawFetch: vi.fn() }));
vi.mock("@/lib/external/fetch", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/external/fetch")>("@/lib/external/fetch");
  return { ...actual, rawFetch: fetchMod.rawFetch };
});

const searchMod = vi.hoisted(() => ({ webSearch: vi.fn() }));
vi.mock("@/lib/external/search", () => ({ webSearch: searchMod.webSearch }));

const docsMod = vi.hoisted(() => ({ searchDocs: vi.fn() }));
vi.mock("@/lib/external/docs", () => ({ searchDocs: docsMod.searchDocs }));

function setEnv(allow: string, black: string) {
  process.env.WEB_FETCH_DOMAIN_ALLOWLIST = allow;
  process.env.WEB_FETCH_DOMAIN_BLACKLIST = black;
}

beforeEach(() => {
  setEnv("", "");
  vi.clearAllMocks();
  queryMocks.listPermissionRules.mockResolvedValue([]);
  queryMocks.findMatchingApprovals.mockResolvedValue([]);
  queryMocks.createToolRun.mockResolvedValue({ id: "tr-1" });
  queryMocks.requestApprovalAtomic.mockResolvedValue({
    run: { id: "run-ask", status: "awaiting_approval" },
    approval: { id: "apr-1" },
  });
  queryMocks.finishToolRunSuccess.mockResolvedValue(undefined);
  queryMocks.finishToolRunFailure.mockResolvedValue(undefined);
  queryMocks.appendThreadEvent.mockResolvedValue(undefined);
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  setEnv("", "");
});

type ToolLike = { execute?: (...args: never[]) => unknown };
async function callExecute(tool: ToolLike, input: unknown): Promise<Record<string, unknown>> {
  if (!tool.execute) throw new Error("tool.execute missing");
  return (await tool.execute(
    input as never,
    {
      toolCallId: "t",
      messages: [],
    } as never,
  )) as Record<string, unknown>;
}

// 计算与引擎一致的 argFingerprint，用于构造既有批准
function expectedFp(permissionKey: string, input: Record<string, unknown>): string {
  return computeArgFingerprint(permissionKey, input);
}

describe("webFetch 经 executeToolRun + 域名治理", () => {
  it("域内 → allow → runner 执行 + external.fetched 事件 + 来源标记", async () => {
    setEnv("example.com", "");
    fetchMod.rawFetch.mockResolvedValue({
      ok: true,
      url: "https://example.com/p",
      text: "Hi",
      truncated: false,
      bytes: 2,
      contentType: "text/html",
      source: {
        sourceUrl: "https://example.com/p",
        fetchedAt: "2026-06-23T00:00:00.000Z",
        expiresAt: "2026-06-24T00:00:00.000Z",
        contentHash: "abc",
        artifactPath: ".snow/runtime/tid/external/x.txt",
      },
    });
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.webFetch, { url: "https://example.com/p" });
    expect(out.ok).toBe(true);
    expect(out.sourceUrl).toBe("https://example.com/p");
    expect(out.contentHash).toBe("abc");
    // external.fetched 事件被追加
    const types = queryMocks.appendThreadEvent.mock.calls.map((c) => c[1]);
    expect(types).toContain("external.fetched");
    // allow 路径不创建审批
    expect(queryMocks.requestApprovalAtomic).not.toHaveBeenCalled();
  });

  it("域外 → ask → awaitingApproval + 创建审批 + 暂停 thread", async () => {
    setEnv("example.com", "");
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.webFetch, { url: "https://other.com/x" });
    expect(out.ok).toBe(false);
    expect(out.awaitingApproval).toBe(true);
    expect(queryMocks.requestApprovalAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ permissionKey: "web.fetch", toolName: "webFetch" }),
    );
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalledWith(TID, "awaiting_approval");
    // ask 不跑 runner
    expect(fetchMod.rawFetch).not.toHaveBeenCalled();
  });

  it("黑名单 → deny → fail-closed（tool.failed, policy）", async () => {
    setEnv("example.com", "evil.com");
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.webFetch, { url: "https://evil.com/x" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("policy");
    expect(queryMocks.finishToolRunFailure).toHaveBeenCalled();
    expect(fetchMod.rawFetch).not.toHaveBeenCalled();
  });

  it("空 allowlist → deny（fail-closed）", async () => {
    setEnv("", "");
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.webFetch, { url: "https://example.com/x" });
    expect(out.ok).toBe(false);
    expect(fetchMod.rawFetch).not.toHaveBeenCalled();
  });

  it("域外 + 既有批准 → ask 升级 allow → runner 执行", async () => {
    setEnv("example.com", "");
    queryMocks.findMatchingApprovals.mockResolvedValue([
      {
        id: "apr-old",
        threadId: TID,
        permissionKey: "web.fetch",
        argFingerprint: expectedFp("web.fetch", { url: "https://other.com/x" }),
        status: "approved",
        approvedScope: "thread",
        expiresAt: null,
      },
    ]);
    fetchMod.rawFetch.mockResolvedValue({
      ok: true,
      url: "https://other.com/x",
      text: "approved",
      truncated: false,
      bytes: 8,
      contentType: "text/html",
      source: {
        sourceUrl: "https://other.com/x",
        fetchedAt: "2026-06-23T00:00:00.000Z",
        expiresAt: "2026-06-24T00:00:00.000Z",
        contentHash: "h",
        artifactPath: ".snow/runtime/tid/external/y.txt",
      },
    });
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.webFetch, { url: "https://other.com/x" });
    expect(out.ok).toBe(true);
    expect(fetchMod.rawFetch).toHaveBeenCalled();
  });
});

describe("webSearch / searchDocs 经 executeToolRun", () => {
  it("webSearch 域内 allowlist → allow → 结构化结果", async () => {
    setEnv("react.dev", "");
    searchMod.webSearch.mockResolvedValue({
      ok: true,
      query: "react",
      results: [{ title: "React", url: "https://react.dev/learn", snippet: "s" }],
      source: { sourceUrl: "ddg", fetchedAt: "t", expiresAt: "e", contentHash: "h" },
    });
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.webSearch, { query: "react" });
    expect(out.ok).toBe(true);
  });

  it("searchDocs 文档域未配置 → deny（runner 内部返回 denied，记 business failure）", async () => {
    Reflect.deleteProperty(process.env, "SNOW_DOCS_DOMAINS");
    docsMod.searchDocs.mockResolvedValue({
      ok: false,
      denied: true,
      reason: "文档域 allowlist 为空",
    });
    const { buildWebTools } = await import("./web");
    const tools = buildWebTools(TID);
    const out = await callExecute(tools.searchDocs, { query: "hooks" });
    expect(out.ok).toBe(false);
    expect(out.denied).toBe(true);
  });
});
