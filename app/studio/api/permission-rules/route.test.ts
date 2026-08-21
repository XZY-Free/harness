import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1(07-P2-5):permission rule 管理 API 守卫 + 校验 + 审计触发。
 *
 * mock 正式授权层(requireStudioAction) + db/queries(四个 CRUD 函数)。校验逻辑(permission-rule-validation)用真——
 * 它是纯函数,直接覆盖 scope/decision/toolPattern/argMatcher/ReDoS 各分支。
 * 核心断言:写操作传 actorUserId(审计触发)、校验失败 400、守卫 401/403。
 */

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  listPermissionRules: vi.fn(),
  createPermissionRule: vi.fn(),
  updatePermissionRule: vi.fn(),
  deletePermissionRule: vi.fn(),
  listAdminAuditLogs: vi.fn(),
}));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/db/queries", () => ({
  listPermissionRules: queries.listPermissionRules,
  createPermissionRule: queries.createPermissionRule,
  updatePermissionRule: queries.updatePermissionRule,
  deletePermissionRule: queries.deletePermissionRule,
  listAdminAuditLogs: queries.listAdminAuditLogs,
}));

import { DELETE as DELETE_RULE, PATCH } from "@/app/studio/api/permission-rules/[id]/route";
import { GET as GET_AUDIT } from "@/app/studio/api/permission-rules/audit/route";
import { GET, POST } from "@/app/studio/api/permission-rules/route";
import { NextRequest } from "next/server";

const PRINCIPAL = {
  tenantId: "t1",
  tenantKey: "t1",
  userIdentityId: "u1",
  externalSubject: "u1",
  email: "a@x",
  displayName: "A",
  audience: "employee",
} as const;
const RULE = {
  id: "r1",
  scope: "global",
  scopeRef: null,
  toolPattern: "tool.writeFile",
  argMatcher: null,
  decision: "deny",
  reason: null,
  priority: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  queries.createPermissionRule.mockResolvedValue(RULE);
  queries.updatePermissionRule.mockResolvedValue(RULE);
  queries.deletePermissionRule.mockResolvedValue(true);
  queries.listPermissionRules.mockResolvedValue([RULE]);
  queries.listAdminAuditLogs.mockResolvedValue([]);
});

describe("GET /studio/api/permission-rules", () => {
  it("policy.read 通过 → 200 + 规则列表", async () => {
    studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
    const res = await GET(req("GET", "/studio/api/permission-rules"));
    expect(res.status).toBe(200);
    expect(studio.requireStudioAction).toHaveBeenCalledWith(expect.anything(), "policy.read");
    expect(queries.listPermissionRules).toHaveBeenCalled();
  });

  it("无 policy.read → 守卫拒绝", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET(req("GET", "/studio/api/permission-rules"));
    expect(res.status).toBe(403);
  });
});

describe("POST /studio/api/permission-rules (新建 + 审计触发)", () => {
  it("合法输入 → 200 + 传 actorUserId 触发审计", async () => {
    const res = await POST(
      req("POST", "/studio/api/permission-rules", {
        scope: "global",
        toolPattern: "tool.writeFile",
        decision: "deny",
        argMatcher: { pathRegex: "^secrets/.*" },
        priority: 100,
      }),
    );
    expect(res.status).toBe(200);
    // 核心:传 actorUserId → createPermissionRule 内部同事务落 permission_rule.created 审计
    expect(queries.createPermissionRule).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "u1", decision: "deny", priority: 100 }),
    );
  });

  it("非法 scope → 400", async () => {
    const res = await POST(
      req("POST", "/studio/api/permission-rules", {
        scope: "invalid",
        toolPattern: "tool.writeFile",
        decision: "deny",
      }),
    );
    expect(res.status).toBe(400);
    expect(queries.createPermissionRule).not.toHaveBeenCalled();
  });

  it("ReDoS 风险 pathRegex → 400(写入前拒绝)", async () => {
    const res = await POST(
      req("POST", "/studio/api/permission-rules", {
        scope: "global",
        toolPattern: "tool.runCommand",
        decision: "deny",
        argMatcher: { commandRegex: "(a+)+$" },
      }),
    );
    expect(res.status).toBe(400);
    expect(queries.createPermissionRule).not.toHaveBeenCalled();
  });

  it("scope=project 缺 scopeRef → 400", async () => {
    const res = await POST(
      req("POST", "/studio/api/permission-rules", {
        scope: "project",
        toolPattern: "tool.writeFile",
        decision: "deny",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("无 policy.write → 守卫拒绝", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await POST(
      req("POST", "/studio/api/permission-rules", { toolPattern: "x", decision: "deny" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /studio/api/permission-rules/[id] (更新 + 审计)", () => {
  it("合法 patch → 200 + 传 actorUserId", async () => {
    const res = await PATCH(
      req("PATCH", "/studio/api/permission-rules/r1", { decision: "allow", priority: 10 }),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.updatePermissionRule).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ decision: "allow", priority: 10 }),
      "u1",
    );
  });

  it("规则不存在 → 404", async () => {
    queries.updatePermissionRule.mockResolvedValue(null);
    const res = await PATCH(
      req("PATCH", "/studio/api/permission-rules/r1", { decision: "allow" }),
      {
        params: Promise.resolve({ id: "r1" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("空 patch → 400", async () => {
    const res = await PATCH(req("PATCH", "/studio/api/permission-rules/r1", {}), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /studio/api/permission-rules/[id] (二次确认 + 审计)", () => {
  it("缺 confirm → 400", async () => {
    const res = await DELETE_RULE(req("DELETE", "/studio/api/permission-rules/r1"), {
      params: Promise.resolve({ id: "r1" }),
    });
    expect(res.status).toBe(400);
    expect(queries.deletePermissionRule).not.toHaveBeenCalled();
  });

  it("confirm: true → 200 + 传 actorUserId", async () => {
    const res = await DELETE_RULE(
      req("DELETE", "/studio/api/permission-rules/r1", { confirm: true }),
      {
        params: Promise.resolve({ id: "r1" }),
      },
    );
    expect(res.status).toBe(200);
    expect(queries.deletePermissionRule).toHaveBeenCalledWith("r1", "u1");
  });

  it("规则不存在 → 404", async () => {
    queries.deletePermissionRule.mockResolvedValue(false);
    const res = await DELETE_RULE(
      req("DELETE", "/studio/api/permission-rules/r1", { confirm: true }),
      {
        params: Promise.resolve({ id: "r1" }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /studio/api/permission-rules/audit (变更历史)", () => {
  it("audit.read 通过 → 200 + 按 targetType=permission_rule 查审计", async () => {
    const res = await GET_AUDIT(req("GET", "/studio/api/permission-rules/audit"));
    expect(res.status).toBe(200);
    expect(queries.listAdminAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "permission_rule" }),
    );
  });

  it("无 audit.read → 守卫拒绝", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET_AUDIT(req("GET", "/studio/api/permission-rules/audit"));
    expect(res.status).toBe(403);
  });
});
