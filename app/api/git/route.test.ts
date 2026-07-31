import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-3 Stage D + S1（09-P1-6）：git delivery API owner guard + 权限引擎。
 * - owner → 放行（直接 deliverToGit）
 * - 非 owner + thread 不存在 → 404
 * - 非 owner + thread 存在 + 无 allow rule → 403
 * - 非 owner + thread 存在 + 有显式 allow rule → 放行
 */

const auth = vi.hoisted(() => ({
  getCurrentUserFromRequest: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  requireThreadForUser: vi.fn(),
  getThreadById: vi.fn(),
  listPermissionRules: vi.fn(),
}));
const deliver = vi.hoisted(() => ({
  deliverToGit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserFromRequest: auth.getCurrentUserFromRequest,
  authErrorResponse: (error: unknown) =>
    error instanceof Error && error.message.includes("SSO")
      ? new Response(null, { status: 401 })
      : null,
}));
vi.mock("@/lib/db/queries", () => ({
  requireThreadForUser: queries.requireThreadForUser,
  getThreadById: queries.getThreadById,
  listPermissionRules: queries.listPermissionRules,
}));
vi.mock("@/lib/git/deliver", () => ({ deliverToGit: deliver.deliverToGit }));

import { POST } from "@/app/api/git/route";

const OWNED = { id: "t1", userId: "u1", projectId: null };
const OTHER_THREAD = { id: "t2", userId: "u-other", projectId: null };

function req(body: unknown): Request {
  return new Request("http://localhost/api/git", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUserFromRequest.mockResolvedValue({ id: "u1" });
  queries.listPermissionRules.mockResolvedValue([]);
});

describe("POST /api/git owner guard (Phase 4-3)", () => {
  it("foreign thread 且不存在 → 404 且不 deliverToGit", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    queries.getThreadById.mockResolvedValue(null);
    const res = await POST(req({ threadId: "t1", remoteUrl: "https://example.com/repo.git" }));
    expect(res.status).toBe(404);
    expect(deliver.deliverToGit).not.toHaveBeenCalled();
  });

  it("owned thread → 调 deliverToGit 一次（透传 options）", async () => {
    queries.requireThreadForUser.mockResolvedValue(OWNED);
    deliver.deliverToGit.mockResolvedValue({ ok: true, pushed: true });
    const res = await POST(
      req({
        threadId: "t1",
        remoteUrl: "https://example.com/repo.git",
        commitMessage: "msg",
        branch: "main",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: true, pushed: true });
    expect(deliver.deliverToGit).toHaveBeenCalledTimes(1);
    expect(deliver.deliverToGit).toHaveBeenCalledWith("t1", "https://example.com/repo.git", {
      commitMessage: "msg",
      branch: "main",
    });
  });

  it("缺 remoteUrl → 400，不触发 auth / delivery", async () => {
    const res = await POST(req({ threadId: "t1" }));
    expect(res.status).toBe(400);
    expect(auth.getCurrentUserFromRequest).not.toHaveBeenCalled();
    expect(deliver.deliverToGit).not.toHaveBeenCalled();
  });

  it("缺 SSO 身份 → 401，不查 thread / 不 deliver", async () => {
    auth.getCurrentUserFromRequest.mockRejectedValue(new Error("缺少 SSO 用户邮箱"));
    const res = await POST(req({ threadId: "t1", remoteUrl: "https://example.com/repo.git" }));
    expect(res.status).toBe(401);
    expect(queries.requireThreadForUser).not.toHaveBeenCalled();
    expect(deliver.deliverToGit).not.toHaveBeenCalled();
  });
});

// S1（09-P1-6）：权限引擎——非 owner 需显式 allow rule
describe("POST /api/git 权限引擎（非 owner）", () => {
  it("非 owner + thread 存在 + 无 allow rule → 403 且不 deliver", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    queries.getThreadById.mockResolvedValue(OTHER_THREAD);
    queries.listPermissionRules.mockResolvedValue([]); // 无 DB 规则 → 默认 ask → 非 allow

    const res = await POST(req({ threadId: "t2", remoteUrl: "https://example.com/repo.git" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code ?? body.code).toBe("permission_denied");
    expect(deliver.deliverToGit).not.toHaveBeenCalled();
  });

  it("非 owner + thread 存在 + 有显式 allow rule → 放行 deliverToGit", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    queries.getThreadById.mockResolvedValue(OTHER_THREAD);
    queries.listPermissionRules.mockResolvedValue([
      {
        id: "rule-allow-gitpush",
        scope: "global",
        scopeRef: null,
        toolPattern: "tool.gitPush",
        argMatcher: null,
        decision: "allow",
        reason: "ops 团队显式放行 gitPush",
        priority: 100,
      },
    ]);
    deliver.deliverToGit.mockResolvedValue({ ok: true, pushed: true });

    const res = await POST(
      req({ threadId: "t2", remoteUrl: "https://example.com/repo.git", branch: "main" }),
    );
    expect(res.status).toBe(200);
    expect(deliver.deliverToGit).toHaveBeenCalledWith("t2", "https://example.com/repo.git", {
      commitMessage: undefined,
      branch: "main",
    });
  });

  it("非 owner + thread 存在 + 仅 deny rule → 403", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    queries.getThreadById.mockResolvedValue(OTHER_THREAD);
    queries.listPermissionRules.mockResolvedValue([
      {
        id: "rule-deny-gitpush",
        scope: "global",
        scopeRef: null,
        toolPattern: "tool.gitPush",
        argMatcher: null,
        decision: "deny",
        reason: "禁止 gitPush",
        priority: 100,
      },
    ]);

    const res = await POST(req({ threadId: "t2", remoteUrl: "https://example.com/repo.git" }));
    expect(res.status).toBe(403);
    expect(deliver.deliverToGit).not.toHaveBeenCalled();
  });
});
