import { createAgent } from "@/lib/agents/persistence/agent-queries";
/**
 * S02-C03：动作资源授权集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - resource-scope：parse/validate/serialize/scopeCovers（纯逻辑）。
 * - action-codes：目录完整性、isKnownActionCode、assertActionResourceTypeMatch（纯逻辑）。
 * - role-action-queries：grant/revoke/list/getById/parseBindingScope（DB）。
 * - authorization：checkActionScope/checkServiceActionScope/requireActionScope（DB + 纯逻辑）。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  ACTION_CODES,
  ACTION_RESOURCE_TYPES,
  type ActionCode,
  assertActionResourceTypeMatch,
  isKnownActionCode,
} from "@/lib/identity/action-codes";
import {
  checkActionScope,
  checkServiceActionScope,
  requireActionScope,
  resolveActionScopeCoverage,
} from "@/lib/identity/authorization";
import { changePermissionManagement } from "@/lib/identity/permission-management";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import type { Principal, WorkloadPrincipal } from "@/lib/identity/resolver";
import {
  type ResourceScope,
  ResourceScopeError,
  parseResourceScope,
  scopeCovers,
  serializeResourceScope,
  validateResourceScope,
} from "@/lib/identity/resource-scope";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentTable } from "@/lib/persistence/schema/agents";
import { permissionRoleAssignment } from "@/lib/persistence/schema/authorization";
import { userIdentity as userIdentityTable } from "@/lib/persistence/schema/identity";
import {
  revokeSeededActionPermission,
  seedActionPermission,
} from "@/lib/test-support/seed-action-permission";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

describe("平台默认员工权限", () => {
  it("有效新员工拥有自己的会话权限，但没有后台访问权", async () => {
    const tenant = await ensureDefaultTenant();
    const { identity } = await seedUser(tenant.id, "new-employee", "employee@example.test");
    expect(
      await checkActionScope(tenant.id, identity.id, {
        actionCode: "thread.write",
        resource: { type: "self", id: identity.id },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      await checkActionScope(tenant.id, identity.id, {
        actionCode: "studio.access",
        resource: { type: "tenant", id: tenant.id },
      }),
    ).toMatchObject({ allowed: false });
  });
});

afterEach(() => {
  // 无外部状态污染（process.env 等未修改）
});

// ─── 辅助：seed 租户 + 用户 + 主体绑定 ─────────────────────

async function seedUser(tenantId: string, externalSubject: string, email: string) {
  const identity = await upsertUserIdentity({
    tenantId,
    externalSubject,
    email,
    displayName: `Test ${externalSubject}`,
  });
  const binding = await upsertPrincipalBinding({
    tenantId,
    subjectType: "user",
    externalId: externalSubject,
    displayName: `Test ${externalSubject}`,
    userIdentityId: identity.id,
  });
  return { identity, binding };
}

// ─── resource-scope（纯逻辑）──────────────────────────────

describe("resource-scope", () => {
  it("parseResourceScope wildcard 解析成功", () => {
    const scope = parseResourceScope('{"type":"agent","wildcard":true}');
    expect(scope.type).toBe("agent");
    expect(scope.wildcard).toBe(true);
  });

  it("parseResourceScope ids 解析成功", () => {
    const scope = parseResourceScope('{"type":"agent","ids":["agt_1","agt_2"]}');
    expect(scope.type).toBe("agent");
    expect(scope.ids).toEqual(["agt_1", "agt_2"]);
    expect(scope.wildcard).toBeUndefined();
  });

  it("parseResourceScope 非 JSON 抛 malformed_scope", () => {
    expect(() => parseResourceScope("not json")).toThrow(ResourceScopeError);
    expect(() => parseResourceScope("not json")).toThrow(/不是合法 JSON/);
  });

  it("validateResourceScope 非对象抛 malformed_scope", () => {
    expect(() => validateResourceScope("string")).toThrow(ResourceScopeError);
    expect(() => validateResourceScope(null)).toThrow(ResourceScopeError);
    expect(() => validateResourceScope(42)).toThrow(ResourceScopeError);
  });

  it("validateResourceScope type 非字符串抛 malformed_scope", () => {
    expect(() => validateResourceScope({ type: 123 })).toThrow(ResourceScopeError);
  });

  it("validateResourceScope 未知 type 抛 unknown_scope_type", () => {
    expect(() => validateResourceScope({ type: "unknown_type", wildcard: true })).toThrow(
      /未知 resource scope type/,
    );
  });

  it("validateResourceScope 空 allowlist（无 wildcard 无 ids）抛 malformed_scope", () => {
    expect(() => validateResourceScope({ type: "agent" })).toThrow(/必须指定 wildcard 或非空 ids/);
    expect(() => validateResourceScope({ type: "agent", ids: [] })).toThrow(
      /必须指定 wildcard 或非空 ids/,
    );
  });

  it("validateResourceScope ids 非字符串数组抛 malformed_scope", () => {
    expect(() => validateResourceScope({ type: "agent", ids: [123] })).toThrow(
      /ids 必须是字符串数组/,
    );
    expect(() => validateResourceScope({ type: "agent", ids: "agt_1" })).toThrow(
      /ids 必须是字符串数组/,
    );
  });

  it("serializeResourceScope 稳定字段顺序", () => {
    const scope: ResourceScope = { type: "agent", wildcard: true, ids: ["agt_1"] };
    const json = serializeResourceScope(scope);
    // 字段顺序：type, wildcard, ids
    expect(json).toBe('{"type":"agent","wildcard":true,"ids":["agt_1"]}');
  });

  it("scopeCovers type 匹配 + wildcard → true", () => {
    const binding: ResourceScope = { type: "agent", wildcard: true };
    expect(scopeCovers(binding, { type: "agent", id: "agt_any" })).toBe(true);
  });

  it("scopeCovers type 匹配 + ids 包含 → true", () => {
    const binding: ResourceScope = { type: "agent", ids: ["agt_1", "agt_2"] };
    expect(scopeCovers(binding, { type: "agent", id: "agt_1" })).toBe(true);
  });

  it("scopeCovers type 匹配 + ids 不包含 → false", () => {
    const binding: ResourceScope = { type: "agent", ids: ["agt_1"] };
    expect(scopeCovers(binding, { type: "agent", id: "agt_2" })).toBe(false);
  });

  it("scopeCovers type 不匹配 → false", () => {
    const binding: ResourceScope = { type: "agent", wildcard: true };
    expect(scopeCovers(binding, { type: "tool", id: "tool_1" })).toBe(false);
  });
});

// ─── action-codes（纯逻辑）────────────────────────────────

describe("action-codes", () => {
  it("ACTION_CODES 包含方案 §5.1 最低 15 个动作（随阶段推进扩展）", () => {
    // 方案 §5.1 最低动作集 15 个；后续阶段（5/6/7）扩展 runtime.publish / skill.* / tool.* / memory.review 等。
    expect(ACTION_CODES.length).toBeGreaterThanOrEqual(15);
    expect(ACTION_CODES).toContain("agent.publish");
    expect(ACTION_CODES).toContain("agent.invoke");
    expect(ACTION_RESOURCE_TYPES["agent.invoke"]).toEqual(["tenant", "agent"]);
    expect(ACTION_CODES).toContain("artifact.attestation.verify");
    expect(ACTION_CODES).toContain("deletion.request");
    expect(ACTION_CODES).toContain("audit.export");
  });

  it("ACTION_RESOURCE_TYPES 每个动作都有允许的 scope types", () => {
    for (const code of ACTION_CODES) {
      expect(ACTION_RESOURCE_TYPES[code]).toBeDefined();
      expect(ACTION_RESOURCE_TYPES[code].length).toBeGreaterThan(0);
    }
  });

  it("isKnownActionCode 已知动作 → true", () => {
    expect(isKnownActionCode("agent.publish")).toBe(true);
    expect(isKnownActionCode("policy.publish")).toBe(true);
  });

  it("isKnownActionCode 未知动作 → false", () => {
    expect(isKnownActionCode("agent.revision.draft")).toBe(false);
    expect(isKnownActionCode("unknown.action")).toBe(false);
    expect(isKnownActionCode("")).toBe(false);
  });

  it("assertActionResourceTypeMatch 匹配时不抛错", () => {
    expect(() => assertActionResourceTypeMatch("agent.publish", "agent")).not.toThrow();
    expect(() => assertActionResourceTypeMatch("agent.publish", "environment")).not.toThrow();
  });

  it("assertActionResourceTypeMatch 不匹配抛 scope_type_mismatch", () => {
    expect(() => assertActionResourceTypeMatch("agent.publish", "tool")).toThrow(
      ResourceScopeError,
    );
    expect(() => assertActionResourceTypeMatch("agent.publish", "tool")).toThrow(
      /不允许 resource scope type tool/,
    );
  });
});

// ─── authorization（DB + 纯逻辑）─────────────────────────

describe("authorization", () => {
  let tenantId: string;
  let userIdentityId: string;
  let principalBindingId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
    const { identity, binding } = await seedUser(tenantId, "admin-001", "admin001@example.com");
    userIdentityId = identity.id;
    principalBindingId = binding.id;
    const resourceOwner = await upsertUserIdentity({
      tenantId,
      externalSubject: "resource-owner",
      email: "owner@example.test",
      displayName: "资产负责人",
    });
    for (const id of ["agt_1", "agt_2", "agt_any"])
      await db
        .insert(agentTable)
        .values({
          id,
          tenantId,
          agentKey: id,
          displayName: id,
          ownerUserId: resourceOwner.id,
          lifecycleState: "enabled",
          currentRevisionId: "published",
        });
  });

  // ── checkActionScope ──

  it("checkActionScope 未知 action → deny (unknown_action)", async () => {
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "unknown.action" as ActionCode,
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unknown_action");
  });

  it("checkActionScope 空 allowlist（无绑定）→ deny (empty_allowlist)", async () => {
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_allowlist");
  });

  it("checkActionScope wildcard 绑定 → allow", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_any" },
    });
    expect(result.allowed).toBe(true);
  });

  it("checkActionScope agent.invoke tenant wildcard 覆盖租户内 exact Agent", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.invoke",
      resourceScope: { type: "tenant", wildcard: true },
    });
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.invoke",
      resource: { type: "agent", id: "agt_any" },
    });
    expect(result.allowed).toBe(true);
  });

  it("checkActionScope agent.invoke tenant exact 只接受当前 tenant id", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.invoke",
      resourceScope: { type: "tenant", ids: ["wrong-tenant"] },
    });
    expect(
      await checkActionScope(tenantId, userIdentityId, {
        actionCode: "agent.invoke",
        resource: { type: "agent", id: "agt_any" },
      }),
    ).toMatchObject({ allowed: false });

    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.invoke",
      resourceScope: { type: "tenant", ids: [tenantId] },
    });
    expect(
      await checkActionScope(tenantId, userIdentityId, {
        actionCode: "agent.invoke",
        resource: { type: "agent", id: "agt_any" },
      }),
    ).toEqual({ allowed: true });
  });

  it("resolveActionScopeCoverage 汇总 exact ids，授权撤销后 digest 改变并 fail-closed", async () => {
    const binding = await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.invoke",
      resourceScope: { type: "agent", ids: ["agt_2", "agt_1"] },
    });
    const before = await resolveActionScopeCoverage(tenantId, userIdentityId, {
      actionCode: "agent.invoke",
      resourceType: "agent",
    });
    expect(before.wildcard).toBe(false);
    expect(before.resourceIds).toEqual(["agt_1", "agt_2"]);

    await revokeSeededActionPermission(tenantId, binding.id);
    const after = await resolveActionScopeCoverage(tenantId, userIdentityId, {
      actionCode: "agent.invoke",
      resourceType: "agent",
    });
    expect(after.resourceIds).toEqual([]);
    expect(after.authorizationDigest).not.toBe(before.authorizationDigest);
  });

  it("resolveActionScopeCoverage 忽略 wrong resource 与 future binding", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.invoke",
      resourceScope: { type: "agent", ids: ["future-agent"] },
      validFrom: new Date(Date.now() + 60_000),
    });
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.read",
      resourceScope: { type: "agent", wildcard: true },
    });
    const coverage = await resolveActionScopeCoverage(tenantId, userIdentityId, {
      actionCode: "agent.invoke",
      resourceType: "agent",
    });
    expect(coverage.wildcard).toBe(false);
    expect(coverage.resourceIds).toEqual([]);
  });

  it("checkActionScope ids 绑定包含目标 → allow", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", ids: ["agt_1", "agt_2"] },
    });
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(true);
  });

  it("checkActionScope ids 绑定不包含目标 → deny (action_scope_denied)", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", ids: ["agt_1"] },
    });
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_2" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("action_scope_denied");
  });

  it("checkActionScope 已撤销绑定不生效 → deny (empty_allowlist)", async () => {
    const binding = await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    await revokeSeededActionPermission(tenantId, binding.id);
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_allowlist");
  });

  it("checkActionScope 不同 actionCode 的绑定不匹配 → deny (empty_allowlist)", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "policy.publish",
      resource: { type: "tenant", id: "tenant_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_allowlist");
  });

  it("checkActionScope 跨租户用户 → deny (empty_allowlist)", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const result = await checkActionScope(tenantId, "nonexistent-user-id", {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_allowlist");
  });

  // ── checkServiceActionScope ──

  it("checkServiceActionScope cicd 允许的动作 → allow", () => {
    const result = checkServiceActionScope("cicd", {
      actionCode: "artifact.attestation.verify",
      resource: { type: "artifact_type", id: "agent_yaml" },
    });
    expect(result.allowed).toBe(true);
  });

  it("checkServiceActionScope cicd 拒绝未授权动作 → deny", () => {
    const result = checkServiceActionScope("cicd", {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("action_scope_denied");
  });

  it("checkServiceActionScope 未知 service → deny", () => {
    const result = checkServiceActionScope("unknown-service", {
      actionCode: "artifact.attestation.verify",
      resource: { type: "artifact_type", id: "agent_yaml" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("action_scope_denied");
  });

  it("checkServiceActionScope 未知 action → deny (unknown_action)", () => {
    const result = checkServiceActionScope("cicd", {
      actionCode: "unknown.action" as ActionCode,
      resource: { type: "artifact_type", id: "agent_yaml" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unknown_action");
  });

  // ── requireActionScope ──

  it("requireActionScope Principal 有权 → ok", async () => {
    await seedActionPermission({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const principal: Principal = {
      tenantId,
      tenantKey: "default",
      userIdentityId,
      externalSubject: "admin-001",
      email: "admin001@example.com",
      displayName: "Admin",
      audience: "admin",
    };
    const result = await requireActionScope(principal, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.ok).toBe(true);
  });

  it("requireActionScope Principal 无权 → 403 ACTION_SCOPE_DENIED", async () => {
    const principal: Principal = {
      tenantId,
      tenantKey: "default",
      userIdentityId,
      externalSubject: "admin-001",
      email: "admin001@example.com",
      displayName: "Admin",
      audience: "admin",
    };
    const result = await requireActionScope(principal, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
      expect(body.error.request_id).toBeDefined();
    }
  });

  it("requireActionScope WorkloadPrincipal service 有权 → ok", () => {
    const principal: WorkloadPrincipal = {
      tenantId,
      audience: "admin",
      callerType: "service",
      claims: {
        type: "service",
        tenantId,
        jti: "jti-service-authz-ok-001",
        audience: "admin",
        serviceId: "cicd",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
      serviceId: "cicd",
      invocationId: null,
      runtimeRevisionId: null,
    };
    return requireActionScope(principal, {
      actionCode: "artifact.attestation.verify",
      resource: { type: "artifact_type", id: "agent_yaml" },
    }).then((result) => {
      expect(result.ok).toBe(true);
    });
  });

  it("requireActionScope WorkloadPrincipal service 无权 → 403", () => {
    const principal: WorkloadPrincipal = {
      tenantId,
      audience: "admin",
      callerType: "service",
      claims: {
        type: "service",
        tenantId,
        jti: "jti-service-authz-deny-001",
        audience: "admin",
        serviceId: "cicd",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
      serviceId: "cicd",
      invocationId: null,
      runtimeRevisionId: null,
    };
    return requireActionScope(principal, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    }).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });
  });

  it("requireActionScope WorkloadPrincipal workload（runtime/gateway）→ 403", () => {
    const principal: WorkloadPrincipal = {
      tenantId,
      audience: "runtime",
      callerType: "workload",
      claims: {
        type: "runtime",
        tenantId,
        jti: "jti-runtime-authz-001",
        audience: "runtime",
        invocationId: "inv_1",
        runtimeRevisionId: "rr_1",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
      serviceId: null,
      invocationId: "inv_1",
      runtimeRevisionId: "rr_1",
    };
    return requireActionScope(principal, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    }).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });
  });

  it("requireActionScope 失败响应带 request_id（可跟踪）", async () => {
    const principal: Principal = {
      tenantId,
      tenantKey: "default",
      userIdentityId,
      externalSubject: "admin-001",
      email: "admin001@example.com",
      displayName: "Admin",
      audience: "admin",
    };
    const result = await requireActionScope(
      principal,
      { actionCode: "agent.publish", resource: { type: "agent", id: "agt_1" } },
      "req_test_123",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.headers.get("X-Request-ID")).toBe("req_test_123");
    }
  });
});

describe("正式角色、用户组与资产范围", () => {
  async function setup() {
    const tenant = await ensureDefaultTenant();
    const admin = await seedUser(tenant.id, "permission-admin", "admin@example.test");
    const employee = await seedUser(tenant.id, "permission-employee", "staff@example.test");
    await db
      .insert(permissionRoleAssignment)
      .values({ tenantId: tenant.id, principalId: admin.binding.id, roleKey: "admin" });
    return { tenant, admin, employee };
  }
  it("非法权限输入返回可修正的客户端错误", async () => {
    const { tenant, admin } = await setup();
    await expect(
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "save_role",
        name: "非法角色",
        grants: [{ actionCode: "not.a.permission" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input", status: 400 });
  });
  it("角色保存只修改角色分配，保留资产专项授权", async () => {
    const { tenant, admin, employee } = await setup();
    await db
      .insert(agentTable)
      .values({
        id: "special-agent",
        tenantId: tenant.id,
        agentKey: "special-agent",
        displayName: "专项智能体",
        ownerUserId: admin.identity.id,
        lifecycleState: "enabled",
        currentRevisionId: "published",
      });
    const specific = await seedActionPermission({
      tenantId: tenant.id,
      principalBindingId: employee.binding.id,
      actionCode: "agent.invoke",
      resourceScope: { type: "agent", ids: ["special-agent"] },
    });
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "set_roles",
      principalId: employee.binding.id,
      roleKeys: [specific.id, "auditor"],
      expectedRoleKeys: [specific.id],
    });
    expect(
      (
        await checkActionScope(tenant.id, employee.identity.id, {
          actionCode: "audit.read",
          resource: { type: "tenant", id: tenant.id },
        })
      ).allowed,
    ).toBe(true);
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "set_roles",
      principalId: employee.binding.id,
      roleKeys: [specific.id],
      expectedRoleKeys: [specific.id, "auditor"],
    });
    expect(
      (
        await checkActionScope(tenant.id, employee.identity.id, {
          actionCode: "audit.read",
          resource: { type: "tenant", id: tenant.id },
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await checkActionScope(tenant.id, employee.identity.id, {
          actionCode: "agent.invoke",
          resource: { type: "agent", id: "special-agent" },
        })
      ).allowed,
    ).toBe(true);
  });
  it("受限资产不被 tenant wildcard 绕过；加组和移组同时影响调用与目录范围", async () => {
    const { tenant, admin, employee } = await setup();
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: "hr",
      displayName: "HR",
      ownerUserId: admin.identity.id,
      lifecycleState: "enabled",
    });
    await db
      .update(agentTable)
      .set({ currentRevisionId: "published" })
      .where(eq(agentTable.id, agent.id));
    const group = await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "save_group",
      name: "HR",
      memberIds: [],
    });
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "save_access",
      resourceType: "agent",
      resourceId: agent.id,
      version: 1,
      mode: "restricted",
      principals: [group.id],
      collaborators: [],
    });
    await seedActionPermission({
      tenantId: tenant.id,
      principalBindingId: employee.binding.id,
      actionCode: "agent.invoke",
      resourceScope: { type: "tenant", wildcard: true },
    });
    const check = () =>
      checkActionScope(tenant.id, employee.identity.id, {
        actionCode: "agent.invoke",
        resource: { type: "agent", id: agent.id },
      });
    expect((await check()).allowed).toBe(false);
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "save_group",
      id: group.id,
      version: 1,
      name: "HR",
      memberIds: [employee.identity.id],
    });
    expect((await check()).allowed).toBe(true);
    expect(
      (
        await resolveActionScopeCoverage(tenant.id, employee.identity.id, {
          actionCode: "agent.invoke",
          resourceType: "agent",
        })
      ).resourceIds,
    ).toContain(agent.id);
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "save_group",
      id: group.id,
      version: 2,
      name: "HR",
      memberIds: [],
    });
    expect((await check()).allowed).toBe(false);
    expect(
      (
        await resolveActionScopeCoverage(tenant.id, employee.identity.id, {
          actionCode: "agent.invoke",
          resourceType: "agent",
        })
      ).resourceIds,
    ).not.toContain(agent.id);
  });
  it("新员工默认可用面向全员的已发布资产；停用立即失效", async () => {
    const { tenant, admin, employee } = await setup();
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: "general",
      displayName: "General",
      ownerUserId: admin.identity.id,
      lifecycleState: "enabled",
    });
    await db
      .update(agentTable)
      .set({ currentRevisionId: "published" })
      .where(eq(agentTable.id, agent.id));
    expect(
      (
        await checkActionScope(tenant.id, employee.identity.id, {
          actionCode: "agent.invoke",
          resource: { type: "agent", id: agent.id },
        })
      ).allowed,
    ).toBe(true);
    await db
      .update(userIdentityTable)
      .set({ status: "disabled" })
      .where(eq(userIdentityTable.id, employee.identity.id));
    expect(
      (
        await checkActionScope(tenant.id, employee.identity.id, {
          actionCode: "agent.invoke",
          resource: { type: "agent", id: agent.id },
        })
      ).allowed,
    ).toBe(false);
  });
  it("平台默认范围只影响继承的资产，显式全员范围不被默认变更覆盖", async () => {
    const { tenant, admin, employee } = await setup();
    const inherited = await createAgent({
      tenantId: tenant.id,
      agentKey: "inherited-default",
      displayName: "继承默认",
      ownerUserId: admin.identity.id,
      lifecycleState: "enabled",
    });
    const explicit = await createAgent({
      tenantId: tenant.id,
      agentKey: "explicit-default",
      displayName: "显式全员",
      ownerUserId: admin.identity.id,
      lifecycleState: "enabled",
    });
    for (const agent of [inherited, explicit])
      await db
        .update(agentTable)
        .set({ currentRevisionId: "published" })
        .where(eq(agentTable.id, agent.id));
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "save_access",
      resourceType: "agent",
      resourceId: explicit.id,
      mode: "all",
      principals: [],
      collaborators: [],
      version: 1,
    });
    await changePermissionManagement(tenant.id, admin.identity.id, {
      operation: "save_defaults",
      mode: "restricted",
      version: 0,
    });
    for (const agent of [inherited, explicit])
      expect(
        (
          await checkActionScope(tenant.id, employee.identity.id, {
            actionCode: "agent.invoke",
            resource: { type: "agent", id: agent.id },
          })
        ).allowed,
      ).toBe(agent.id === explicit.id);
    await expect(
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "save_defaults",
        mode: "all",
        version: 0,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
  it("租户级使用授权也不能调用不存在或其他租户的智能体", async () => {
    const { tenant, employee } = await setup();
    await seedActionPermission({
      tenantId: tenant.id,
      principalBindingId: employee.binding.id,
      actionCode: "agent.invoke",
      resourceScope: { type: "tenant", wildcard: true },
    });
    expect(
      (
        await checkActionScope(tenant.id, employee.identity.id, {
          actionCode: "agent.invoke",
          resource: { type: "agent", id: "outside-agent" },
        })
      ).allowed,
    ).toBe(false);
  });
  it("并发互相撤销管理员时只允许一方成功，不能无人可管理", async () => {
    const { tenant, admin, employee } = await setup();
    await db
      .insert(permissionRoleAssignment)
      .values({ tenantId: tenant.id, principalId: employee.binding.id, roleKey: "admin" });
    const results = await Promise.allSettled([
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "set_roles",
        principalId: employee.binding.id,
        roleKeys: [],
        expectedRoleKeys: ["admin"],
      }),
      changePermissionManagement(tenant.id, employee.identity.id, {
        operation: "set_roles",
        principalId: admin.binding.id,
        roleKeys: [],
        expectedRoleKeys: ["admin"],
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const remaining = await Promise.all(
      [admin, employee].map((u) =>
        checkActionScope(tenant.id, u.identity.id, {
          actionCode: "user.manage",
          resource: { type: "tenant", id: tenant.id },
        }),
      ),
    );
    expect(remaining.filter((r) => r.allowed)).toHaveLength(1);
  });
  it("审计写入失败时角色变更也回滚", async () => {
    const { tenant, admin, employee } = await setup();
    await db.execute(
      sql.raw(
        "CREATE TRIGGER permission_audit_failure BEFORE INSERT ON AuditEvent FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test audit unavailable'",
      ),
    );
    try {
      await expect(
        changePermissionManagement(tenant.id, admin.identity.id, {
          operation: "set_roles",
          principalId: employee.binding.id,
          roleKeys: ["auditor"],
          expectedRoleKeys: [],
        }),
      ).rejects.toThrow();
      expect(
        (
          await checkActionScope(tenant.id, employee.identity.id, {
            actionCode: "audit.read",
            resource: { type: "tenant", id: tenant.id },
          })
        ).allowed,
      ).toBe(false);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER permission_audit_failure"));
    }
  });
  it("拒绝超出自身权限的角色及跨租户组成员", async () => {
    const { tenant, admin } = await setup();
    await expect(
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "save_role",
        name: "越权导出",
        grants: [{ actionCode: "audit.export", resourceScope: { type: "tenant", wildcard: true } }],
      }),
    ).rejects.toMatchObject({ code: "delegation_denied" });
    await expect(
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "save_group",
        name: "跨租户组",
        memberIds: ["outside-user"],
      }),
    ).rejects.toMatchObject({ code: "invalid_members" });
  });
  it("过时保存与自锁拒绝且角色分配不变", async () => {
    const { tenant, admin, employee } = await setup();
    await expect(
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "set_roles",
        principalId: employee.binding.id,
        roleKeys: ["auditor"],
        expectedRoleKeys: ["builder"],
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      changePermissionManagement(tenant.id, admin.identity.id, {
        operation: "set_roles",
        principalId: admin.binding.id,
        roleKeys: [],
        expectedRoleKeys: ["admin"],
      }),
    ).rejects.toMatchObject({ code: "self_lockout" });
    expect(
      (
        await checkActionScope(tenant.id, admin.identity.id, {
          actionCode: "user.manage",
          resource: { type: "tenant", id: tenant.id },
        })
      ).allowed,
    ).toBe(true);
  });
});
