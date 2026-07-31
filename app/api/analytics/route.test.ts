import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-2 Stage D / Phase 4-3：Analytics API 端点测试。
 *
 * mock @/lib/analytics/queries（聚合正确性已在 queries.test.ts 覆盖）与 @/lib/auth，
 * 此处只验：
 * - 参数解析（since/until/metric）+ 非法日期/metric → 400
 * - 时间窗口正确透传给查询层
 * - summary 聚合全部、单 metric 路由正确
 * - Phase 4-3：所有查询都带当前用户 userId scope
 * - 只读：无任何 mutation 被调用（queries mock 全为只读函数）
 */

const queries = vi.hoisted(() => ({
  threadSuccessRate: vi.fn(),
  previewSuccessRate: vi.fn(),
  avgCompletionMs: vi.fn(),
  perSkillPerformance: vi.fn(),
  toolFailureBreakdown: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  getCurrentUserFromRequest: vi.fn(),
}));

const rbac = vi.hoisted(() => ({
  hasPermission: vi.fn(),
}));

vi.mock("@/lib/analytics/queries", () => ({
  threadSuccessRate: queries.threadSuccessRate,
  previewSuccessRate: queries.previewSuccessRate,
  avgCompletionMs: queries.avgCompletionMs,
  perSkillPerformance: queries.perSkillPerformance,
  toolFailureBreakdown: queries.toolFailureBreakdown,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: auth.getCurrentUserFromRequest,
  authErrorResponse: (error: unknown) =>
    error instanceof Error && error.message.includes("SSO")
      ? new Response(null, { status: 401 })
      : null,
}));
vi.mock("@/lib/rbac", () => ({
  hasPermission: rbac.hasPermission,
}));

import { GET } from "@/app/api/analytics/route";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.clearAllMocks();
  mockAll();
  auth.getCurrentUserFromRequest.mockResolvedValue({ id: "u1" });
  // 默认无 analytics.read.global（member 视角）
  rbac.hasPermission.mockResolvedValue(false);
});

function req(search: string): NextRequest {
  return new NextRequest(`http://localhost/api/analytics?${search}`);
}

function mockAll() {
  queries.threadSuccessRate.mockResolvedValue({ successRate: 0.5, total: 10 });
  queries.previewSuccessRate.mockResolvedValue({ successRate: 0.8, total: 5 });
  queries.avgCompletionMs.mockResolvedValue({ avgMs: 1234, count: 3 });
  queries.perSkillPerformance.mockResolvedValue([{ skillId: "s1", total: 1 }]);
  queries.toolFailureBreakdown.mockResolvedValue({ totalFailures: 2, policyInterceptRate: 0.5 });
}

describe("GET /api/analytics (Stage D)", () => {
  it("summary：聚合全部 5 类指标，响应经 jsonOk 信封", async () => {
    mockAll();
    const res = await GET(req("metric=summary"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(body.data).toHaveProperty("threadSuccess");
    expect(body.data).toHaveProperty("previewSuccess");
    expect(body.data).toHaveProperty("avgCompletion");
    expect(body.data).toHaveProperty("perSkill");
    expect(body.data).toHaveProperty("toolFailures");
    expect(queries.threadSuccessRate).toHaveBeenCalledTimes(1);
    expect(queries.perSkillPerformance).toHaveBeenCalledTimes(1);
  });

  it("单 metric=tool_failures → 只调对应查询", async () => {
    mockAll();
    const res = await GET(req("metric=tool_failures"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ totalFailures: 2, policyInterceptRate: 0.5 });
    expect(queries.toolFailureBreakdown).toHaveBeenCalledTimes(1);
    expect(queries.threadSuccessRate).not.toHaveBeenCalled();
  });

  it("since/until 透传为 AnalyticsScope（含 userId）", async () => {
    mockAll();
    await GET(req("since=2026-01-01T00:00:00Z&until=2026-02-01T00:00:00Z"));
    const arg = queries.threadSuccessRate.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg.userId).toBe("u1");
    expect(arg.since?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(arg.until?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("省略窗口 → 仍带 userId scope（不传 undefined 全量）", async () => {
    mockAll();
    await GET(req(""));
    const arg = queries.threadSuccessRate.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg).toMatchObject({ userId: "u1" });
    expect(arg.since).toBeUndefined();
    expect(arg.until).toBeUndefined();
  });

  it("summary 把所有查询都限定到当前用户", async () => {
    mockAll();
    await GET(req(""));
    expect(queries.threadSuccessRate.mock.calls[0]?.[0]).toMatchObject({ userId: "u1" });
    expect(queries.previewSuccessRate.mock.calls[0]?.[0]).toMatchObject({ userId: "u1" });
    expect(queries.avgCompletionMs.mock.calls[0]?.[0]).toMatchObject({ userId: "u1" });
    expect(queries.perSkillPerformance.mock.calls[0]?.[0]).toMatchObject({ userId: "u1" });
    expect(queries.toolFailureBreakdown.mock.calls[0]?.[0]).toMatchObject({ userId: "u1" });
  });

  it("非法 since → 400（不触发 auth / 查询）", async () => {
    const res = await GET(req("since=not-a-date"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(auth.getCurrentUserFromRequest).not.toHaveBeenCalled();
    expect(queries.threadSuccessRate).not.toHaveBeenCalled();
  });

  it("非法 metric → 400", async () => {
    const res = await GET(req("metric=bogus"));
    expect(res.status).toBe(400);
  });

  it("缺 SSO 身份 → 401（不调查询）", async () => {
    auth.getCurrentUserFromRequest.mockRejectedValue(new Error("缺少 SSO 用户标识"));
    const res = await GET(req(""));
    expect(res.status).toBe(401);
    expect(queries.threadSuccessRate).not.toHaveBeenCalled();
  });
});

describe("GET /api/analytics scope=global (Phase 4-4)", () => {
  it("member 请求 scope=global → 403，不调查询", async () => {
    rbac.hasPermission.mockResolvedValue(false);
    const res = await GET(req("scope=global"));
    expect(res.status).toBe(403);
    expect(rbac.hasPermission).toHaveBeenCalledWith("u1", "analytics.read.global");
    expect(queries.threadSuccessRate).not.toHaveBeenCalled();
  });

  it("admin 请求 scope=global → 200，查询层收到不带 userId 的 scope", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    const res = await GET(req("scope=global"));
    expect(res.status).toBe(200);
    const arg = queries.threadSuccessRate.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg.userId).toBeUndefined(); // 全局聚合，不带 userId
  });

  it("admin scope=global + since/until → 透传窗口、不带 userId", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    await GET(req("scope=global&since=2026-01-01T00:00:00Z&until=2026-02-01T00:00:00Z"));
    const arg = queries.threadSuccessRate.mock.calls[0]?.[0];
    expect(arg.userId).toBeUndefined();
    expect(arg.since?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("非法 scope → 400", async () => {
    const res = await GET(req("scope=tenant"));
    expect(res.status).toBe(400);
    expect(rbac.hasPermission).not.toHaveBeenCalled();
  });

  it("self 默认零回归：不查 hasPermission，scope 带 userId", async () => {
    await GET(req(""));
    expect(rbac.hasPermission).not.toHaveBeenCalled();
    expect(queries.threadSuccessRate.mock.calls[0]?.[0]).toMatchObject({ userId: "u1" });
  });
});
