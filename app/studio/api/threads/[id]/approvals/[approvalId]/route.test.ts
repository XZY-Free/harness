import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.1 Stage E：审批决议 API 守卫与状态机。覆盖 200 / 400 / 401 / 403 / 404 / 409 / admin。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  getApprovalRequest: vi.fn(),
  resolveApprovalRequest: vi.fn(),
  appendThreadEvent: vi.fn(),
  updateThreadStatus: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
  getApprovalRequest: queries.getApprovalRequest,
  resolveApprovalRequest: queries.resolveApprovalRequest,
  appendThreadEvent: queries.appendThreadEvent,
  updateThreadStatus: queries.updateThreadStatus,
}));

import { POST } from "@/app/studio/api/threads/[id]/approvals/[approvalId]/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function req(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PENDING_APPROVAL = {
  id: "a1",
  threadId: "t1",
  toolRunId: "tr1",
  toolName: "deleteFile",
  permissionKey: "tool.deleteFile",
  argFingerprint: "path:x",
  argSummary: "path=x",
  status: "pending",
  approvedScope: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: new Date(),
  expiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  queries.getApprovalRequest.mockResolvedValue(PENDING_APPROVAL);
  queries.appendThreadEvent.mockResolvedValue(undefined);
  queries.updateThreadStatus.mockResolvedValue(undefined);
  queries.resolveApprovalRequest.mockResolvedValue({
    ...PENDING_APPROVAL,
    status: "approved",
    approvedScope: "thread",
    resolvedBy: "u1",
    resolvedAt: new Date(),
  });
});

describe("POST .../approvals/[approvalId] (Stage E)", () => {
  it("owner + pending → 200，决议 approved(thread) + 写 approval_resolved 事件", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.approval.status).toBe("approved");
    expect(body.data.approval.approvedScope).toBe("thread");
    expect(queries.resolveApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a1",
        decision: "approved",
        scope: "thread",
        resolvedBy: "u1",
      }),
    );
    expect(queries.appendThreadEvent).toHaveBeenCalledWith(
      "t1",
      "tool.approval_resolved",
      expect.objectContaining({ approvalId: "a1", decision: "approved", scope: "thread" }),
    );
  });

  it("denied + once → 200", async () => {
    queries.resolveApprovalRequest.mockResolvedValue({
      ...PENDING_APPROVAL,
      status: "denied",
      approvedScope: "once",
      resolvedBy: "u1",
      resolvedAt: new Date(),
    });
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "denied",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.approval.status).toBe("denied");
  });

  it("approved + session scope → 200（07-P1-6：单条 API 接受 session）", async () => {
    queries.resolveApprovalRequest.mockResolvedValue({
      ...PENDING_APPROVAL,
      status: "approved",
      approvedScope: "session",
      resolvedBy: "u1",
      resolvedAt: new Date(),
    });
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "session",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.resolveApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1", decision: "approved", scope: "session" }),
    );
  });

  it("非法 decision → 400", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "maybe",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("非法 scope → 400", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "forever",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("审批不存在 → 404", async () => {
    queries.getApprovalRequest.mockResolvedValue(null);
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/ghost", {
        decision: "approved",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "ghost" }) },
    );
    expect(res.status).toBe(404);
  });

  it("审批属于其他 thread → 404（不泄露）", async () => {
    queries.getApprovalRequest.mockResolvedValue({ ...PENDING_APPROVAL, threadId: "tOther" });
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("已 resolved → 409", async () => {
    queries.getApprovalRequest.mockResolvedValue({ ...PENDING_APPROVAL, status: "approved" });
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(409);
  });

  it("并发决议（resolveApprovalRequest 返回 null）→ 409", async () => {
    queries.resolveApprovalRequest.mockResolvedValue(null);
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(409);
  });

  it("非 owner → 404", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await POST(
      req("http://localhost/studio/api/threads/tOther/approvals/a1", {
        decision: "approved",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "tOther", approvalId: "a1" }) },
    );
    expect(res.status).toBe(404);
    expect(queries.getApprovalRequest).not.toHaveBeenCalled();
  });

  it("无 studio.access → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/a1", {
        decision: "approved",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1", approvalId: "a1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("admin(thread.read.all) → 可决议他人 thread 的审批", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    queries.getApprovalRequest.mockResolvedValue({ ...PENDING_APPROVAL, threadId: "tOther" });
    queries.resolveApprovalRequest.mockResolvedValue({
      ...PENDING_APPROVAL,
      threadId: "tOther",
      status: "approved",
      approvedScope: "thread",
      resolvedBy: "u1",
      resolvedAt: new Date(),
    });
    const res = await POST(
      req("http://localhost/studio/api/threads/tOther/approvals/a1", {
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "tOther", approvalId: "a1" }) },
    );
    expect(res.status).toBe(200);
  });
});
