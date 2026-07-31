import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（07-P1-6）：批量决议审批 API 测试。
 *
 * 覆盖：
 * - owner 批量 approved → 200，逐条决议 + 写事件
 * - 部分成功（部分已 resolved）→ resolved + errors
 * - 审批不属于该 thread → error
 * - 非法 decision / scope → 400
 * - approvalIds 非数组 → 400
 * - scope=always 需二次确认
 * - admin 可批量决议他人 thread
 * - 非 owner → 404
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getThreadById: vi.fn(),
  requireThreadForUser: vi.fn(),
  getApprovalRequest: vi.fn(),
  resolveApprovalRequest: vi.fn(),
  appendThreadEvent: vi.fn(),
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
}));

import { POST } from "@/app/studio/api/threads/[id]/approvals/batch/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function req(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PENDING = (id: string, threadId = "t1") => ({
  id,
  threadId,
  toolRunId: `tr-${id}`,
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
});

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
  queries.getApprovalRequest.mockImplementation(async (id: string) => PENDING(id));
  queries.resolveApprovalRequest.mockImplementation(async (p: { id: string }) => ({
    ...PENDING(p.id),
    status: "approved",
    approvedScope: "thread",
    resolvedBy: "u1",
    resolvedAt: new Date(),
  }));
  queries.appendThreadEvent.mockResolvedValue(undefined);
});

describe("POST .../approvals/batch (07-P1-6)", () => {
  it("owner 批量 approved → 200，逐条决议 + 写事件", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1", "a2"],
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolvedCount).toBe(2);
    expect(body.data.errorCount).toBe(0);
    expect(queries.resolveApprovalRequest).toHaveBeenCalledTimes(2);
    expect(queries.appendThreadEvent).toHaveBeenCalledTimes(2);
  });

  it("部分成功：部分已 resolved → resolved + errors", async () => {
    queries.getApprovalRequest.mockImplementation(async (id: string) => {
      if (id === "a2") return { ...PENDING("a2"), status: "approved" };
      return PENDING(id);
    });
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1", "a2"],
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolvedCount).toBe(1);
    expect(body.data.errorCount).toBe(1);
    expect(body.data.errors[0]).toMatchObject({
      id: "a2",
      reason: expect.stringContaining("approved"),
    });
  });

  it("审批不属于该 thread → error", async () => {
    queries.getApprovalRequest.mockImplementation(async (id: string) => ({
      ...PENDING(id, "tOther"),
    }));
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1"],
        decision: "denied",
        scope: "once",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errorCount).toBe(1);
    expect(body.data.resolvedCount).toBe(0);
  });

  it("approvalIds 非数组 → 400", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: "a1",
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("approvalIds 空数组 → 400", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: [],
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("非法 decision → 400", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1"],
        decision: "maybe",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("非法 scope → 400", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1"],
        decision: "approved",
        scope: "forever",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("scope=always 需二次确认 → 400（无 confirm）", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1"],
        decision: "approved",
        scope: "always",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("confirm_required");
  });

  it("scope=always + confirm=true → 200", async () => {
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ["a1"],
        decision: "approved",
        scope: "always",
        confirm: true,
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(200);
  });

  it("非 owner → 404", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await POST(
      req("http://localhost/studio/api/threads/tOther/approvals/batch", {
        approvalIds: ["a1"],
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "tOther" }) },
    );
    expect(res.status).toBe(404);
    expect(queries.getApprovalRequest).not.toHaveBeenCalled();
  });

  it("admin 可批量决议他人 thread → 200", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "tOther", userId: "u2" });
    queries.getApprovalRequest.mockImplementation(async (id: string) => PENDING(id, "tOther"));
    const res = await POST(
      req("http://localhost/studio/api/threads/tOther/approvals/batch", {
        approvalIds: ["a1", "a2"],
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "tOther" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolvedCount).toBe(2);
  });

  it("单次上限 100 条 → 超 100 返回 400", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `a${i}`);
    const res = await POST(
      req("http://localhost/studio/api/threads/t1/approvals/batch", {
        approvalIds: ids,
        decision: "approved",
        scope: "thread",
      }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(400);
  });
});
