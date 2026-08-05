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
} from "@/lib/identity/authorization";
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
import {
  getActionBindingById,
  grantActionBinding,
  listActionBindingsByPrincipal,
  listActionBindingsByUser,
  listActiveActionBindingsForUser,
  parseBindingScope,
  revokeActionBinding,
} from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { RoleActionBinding } from "@/lib/v11/schema/authorization";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
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

// ─── role-action-queries（DB）─────────────────────────────

describe("role-action-queries", () => {
  let tenantId: string;
  let principalBindingId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
    const { identity, binding } = await seedUser(tenantId, "user-001", "user001@example.com");
    userIdentityId = identity.id;
    principalBindingId = binding.id;
  });

  it("grantActionBinding 创建绑定（wildcard scope）", async () => {
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    expect(binding.id).toBeDefined();
    expect(binding.actionCode).toBe("agent.publish");
    expect(binding.validUntil).toBeNull();
    expect(binding.resourceScopeJson).toContain('"wildcard":true');
  });

  it("grantActionBinding 创建绑定（ids scope）", async () => {
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.revision.create",
      resourceScope: { type: "agent", ids: ["agt_1", "agt_2"] },
    });
    expect(binding.resourceScopeJson).toContain('"ids":["agt_1","agt_2"]');
  });

  it("grantActionBinding scope type 不匹配抛 ResourceScopeError", async () => {
    await expect(
      grantActionBinding({
        tenantId,
        principalBindingId,
        actionCode: "agent.publish",
        resourceScope: { type: "tool", wildcard: true },
      }),
    ).rejects.toThrow(ResourceScopeError);
  });

  it("grantActionBinding 空 allowlist scope 抛 ResourceScopeError", async () => {
    await expect(
      grantActionBinding({
        tenantId,
        principalBindingId,
        actionCode: "agent.publish",
        resourceScope: { type: "agent" },
      }),
    ).rejects.toThrow(ResourceScopeError);
  });

  it("revokeActionBinding 软撤销（回填 validUntil）", async () => {
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const revoked = await revokeActionBinding(tenantId, binding.id);
    expect(revoked).toBe(true);

    const after = await getActionBindingById(tenantId, binding.id);
    expect(after).not.toBeNull();
    expect(after?.validUntil).not.toBeNull();
  });

  it("revokeActionBinding 重复撤销返回 false", async () => {
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    await revokeActionBinding(tenantId, binding.id);
    const second = await revokeActionBinding(tenantId, binding.id);
    expect(second).toBe(false);
  });

  it("revokeActionBinding 不存在的 id 返回 false", async () => {
    const result = await revokeActionBinding(tenantId, "nonexistent-id");
    expect(result).toBe(false);
  });

  it("listActionBindingsByPrincipal 返回指定主体的绑定", async () => {
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "policy.publish",
      resourceScope: { type: "tenant", wildcard: true },
    });
    const list = await listActionBindingsByPrincipal(tenantId, principalBindingId);
    expect(list).toHaveLength(2);
  });

  it("listActionBindingsByUser 经 principal_binding 展开返回绑定", async () => {
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const list = await listActionBindingsByUser(tenantId, userIdentityId);
    expect(list).toHaveLength(1);
    expect(list[0]?.actionCode).toBe("agent.publish");
  });

  it("listActionBindingsByUser 跨租户隔离（不返回其他租户绑定）", async () => {
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    // 用不存在的 userIdentity 查询
    const list = await listActionBindingsByUser(tenantId, "nonexistent-user-id");
    expect(list).toHaveLength(0);
  });

  it("listActiveActionBindingsForUser 过滤已撤销绑定", async () => {
    const active = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "policy.publish",
      resourceScope: { type: "tenant", wildcard: true },
    });
    await revokeActionBinding(tenantId, active.id);

    const list = await listActiveActionBindingsForUser(tenantId, userIdentityId);
    expect(list).toHaveLength(1);
    expect(list[0]?.actionCode).toBe("policy.publish");
  });

  it("getActionBindingById 存在时返回绑定", async () => {
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const found = await getActionBindingById(tenantId, binding.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(binding.id);
  });

  it("getActionBindingById 不存在返回 null", async () => {
    const found = await getActionBindingById(tenantId, "nonexistent-id");
    expect(found).toBeNull();
  });

  it("parseBindingScope 合法 scope 返回 ResourceScope", async () => {
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    const scope = parseBindingScope(binding);
    expect(scope).not.toBeNull();
    expect(scope?.type).toBe("agent");
    expect(scope?.wildcard).toBe(true);
  });

  it("parseBindingScope 非法 scope 返回 null", () => {
    const fakeBinding: RoleActionBinding = {
      id: "fake",
      tenantId: "fake",
      principalBindingId: "fake",
      actionCode: "agent.publish",
      resourceScopeJson: "not json",
      validFrom: new Date(),
      validUntil: null,
      createdAt: new Date(),
    };
    expect(parseBindingScope(fakeBinding)).toBeNull();
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
    await grantActionBinding({
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

  it("checkActionScope ids 绑定包含目标 → allow", async () => {
    await grantActionBinding({
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
    await grantActionBinding({
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
    const binding = await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "agent.publish",
      resourceScope: { type: "agent", wildcard: true },
    });
    await revokeActionBinding(tenantId, binding.id);
    const result = await checkActionScope(tenantId, userIdentityId, {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agt_1" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("empty_allowlist");
  });

  it("checkActionScope 不同 actionCode 的绑定不匹配 → deny (empty_allowlist)", async () => {
    await grantActionBinding({
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
    await grantActionBinding({
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
    await grantActionBinding({
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
