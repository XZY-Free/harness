/**
 * S02-C05：管理审计账本集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - computeContentHash / isKnownAuditActionType / assertAuditActionTypeKnown：纯逻辑。
 * - actorFromPrincipal / actorFromWorkloadPrincipal：纯逻辑（身份映射 + 缺失字段 fail-closed）。
 * - audit-queries：DB（appendAuditEvent / getAuditEventById / listAuditEvents 多维过滤 + 跨租户隔离 / deleteExpiredAuditEvents）。
 * - recordAuditEvent / recordSystemAuditEvent：守卫（已知动作校验 + hash 计算 + 写入 + 显式 hash 优先）。
 * - AuditActionTypeError：未知动作 fail-closed。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  AuditActionTypeError,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
  assertAuditActionTypeKnown,
  computeContentHash,
  isKnownAuditActionType,
  recordAuditEvent,
  recordSystemAuditEvent,
} from "@/lib/identity/audit";
import {
  type AuditEvent,
  appendAuditEvent,
  deleteExpiredAuditEvents,
  getAuditEventById,
  listAuditEvents,
} from "@/lib/identity/audit-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import type { Principal, WorkloadPrincipal } from "@/lib/identity/resolver";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { AUDIT_ACTION_TYPES } from "@/lib/persistence/schema/audit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 + principal ─────────────────────

async function seedCaller(tenantId: string, externalSubject: string, email: string) {
  const identity = await upsertUserIdentity({
    tenantId,
    externalSubject,
    email,
    displayName: `Test ${externalSubject}`,
  });
  await upsertPrincipalBinding({
    tenantId,
    subjectType: "user",
    externalId: externalSubject,
    displayName: `Test ${externalSubject}`,
    userIdentityId: identity.id,
  });
  return identity;
}

function buildPrincipal(tenantId: string, userIdentityId: string): Principal {
  return {
    tenantId,
    tenantKey: "default",
    userIdentityId,
    externalSubject: "user-001",
    email: "user001@example.com",
    displayName: "Test user-001",
    audience: "employee",
  };
}

function buildServicePrincipal(tenantId: string, serviceId: string): WorkloadPrincipal {
  return {
    tenantId,
    audience: "admin",
    callerType: "service",
    claims: {
      type: "service",
      tenantId,
      jti: "jti-service-audit-001",
      audience: "admin",
      serviceId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    },
    serviceId,
    invocationId: null,
    runtimeRevisionId: null,
  };
}

function buildWorkloadPrincipal(tenantId: string, invocationId: string): WorkloadPrincipal {
  return {
    tenantId,
    audience: "runtime",
    callerType: "workload",
    claims: {
      type: "runtime",
      tenantId,
      jti: "jti-runtime-audit-001",
      audience: "runtime",
      invocationId,
      runtimeRevisionId: "rr_test",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    },
    serviceId: null,
    invocationId,
    runtimeRevisionId: "rr_test",
  };
}

// ─── computeContentHash（纯逻辑）──────────────────────────

describe("computeContentHash", () => {
  it("相同内容 → 相同 hash", () => {
    const a = computeContentHash({ a: 1, b: 2 });
    const b = computeContentHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("字段顺序无关 → 相同 hash", () => {
    const a = computeContentHash({ a: 1, b: 2 });
    const b = computeContentHash({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("嵌套 object 字段顺序无关 → 相同 hash", () => {
    const a = computeContentHash({ outer: { z: 1, a: 2 } });
    const b = computeContentHash({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it("不同内容 → 不同 hash", () => {
    const a = computeContentHash({ a: 1 });
    const b = computeContentHash({ a: 2 });
    expect(a).not.toBe(b);
  });

  it("null → null", () => {
    expect(computeContentHash(null)).toBeNull();
  });

  it("undefined → null", () => {
    expect(computeContentHash(undefined)).toBeNull();
  });

  it("hash 是 64 字符 hex（sha256）", () => {
    const hash = computeContentHash({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("数组顺序敏感", () => {
    const a = computeContentHash([1, 2, 3]);
    const b = computeContentHash([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it("原始值（字符串/数字）可计算 hash", () => {
    expect(computeContentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash(42)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── isKnownAuditActionType / assertAuditActionTypeKnown（纯逻辑）───

describe("isKnownAuditActionType", () => {
  it("目录中所有动作类型均已知（包含企业用户资料与 continuation dead-letter，共 56 种）", () => {
    expect(AUDIT_ACTION_TYPES.length).toBe(56);
    for (const actionType of AUDIT_ACTION_TYPES) {
      expect(isKnownAuditActionType(actionType)).toBe(true);
    }
  });

  it("未知动作返回 false", () => {
    expect(isKnownAuditActionType("unknown.action")).toBe(false);
    expect(isKnownAuditActionType("")).toBe(false);
    expect(isKnownAuditActionType("agent.publish.evil")).toBe(false);
  });

  it("目录包含管理写动作与敏感查看类动作", () => {
    // 管理写动作（与 ACTION_CODES 对齐）
    expect(isKnownAuditActionType("agent.publish")).toBe(true);
    expect(isKnownAuditActionType("route.update")).toBe(true);
    expect(isKnownAuditActionType("policy.publish")).toBe(true);
    expect(isKnownAuditActionType("credential.bind")).toBe(true);
    expect(isKnownAuditActionType("credential.revoke")).toBe(true);
    expect(isKnownAuditActionType("deletion.request")).toBe(true);
    expect(isKnownAuditActionType("legal_hold.manage")).toBe(true);
    expect(isKnownAuditActionType("audit.export")).toBe(true);
    // 敏感查看类动作
    expect(isKnownAuditActionType("diagnostic.view")).toBe(true);
    expect(isKnownAuditActionType("audit.read")).toBe(true);
  });
});

describe("assertAuditActionTypeKnown", () => {
  it("已知动作不抛错", () => {
    expect(() => assertAuditActionTypeKnown("agent.publish")).not.toThrow();
    expect(() => assertAuditActionTypeKnown("diagnostic.view")).not.toThrow();
  });

  it("未知动作抛 AuditActionTypeError（fail-closed）", () => {
    expect(() => assertAuditActionTypeKnown("unknown.action")).toThrow(AuditActionTypeError);
    expect(() => assertAuditActionTypeKnown("unknown.action")).toThrow(/未知审计动作类型/);
  });

  it("AuditActionTypeError 携带 actionType 字段", () => {
    try {
      assertAuditActionTypeKnown("bad.action");
      throw new Error("应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(AuditActionTypeError);
      expect((err as AuditActionTypeError).actionType).toBe("bad.action");
      expect((err as AuditActionTypeError).name).toBe("AuditActionTypeError");
    }
  });
});

// ─── actorFromPrincipal / actorFromWorkloadPrincipal（纯逻辑）───

describe("actorFromPrincipal", () => {
  it("Principal → actorType=user, actorId=userIdentityId", () => {
    const principal = buildPrincipal("tnt_1", "uid_1");
    const actor = actorFromPrincipal(principal);
    expect(actor.tenantId).toBe("tnt_1");
    expect(actor.actorType).toBe("user");
    expect(actor.actorId).toBe("uid_1");
  });
});

describe("actorFromWorkloadPrincipal", () => {
  it("service → actorType=service, actorId=serviceId", () => {
    const principal = buildServicePrincipal("tnt_1", "cicd");
    const actor = actorFromWorkloadPrincipal(principal);
    expect(actor.tenantId).toBe("tnt_1");
    expect(actor.actorType).toBe("service");
    expect(actor.actorId).toBe("cicd");
  });

  it("service 缺失 serviceId 抛错", () => {
    const principal = buildServicePrincipal("tnt_1", "cicd");
    principal.serviceId = null;
    expect(() => actorFromWorkloadPrincipal(principal)).toThrow(/缺失 serviceId/);
  });

  it("workload → actorType=workload, actorId=invocationId", () => {
    const principal = buildWorkloadPrincipal("tnt_1", "inv_1");
    const actor = actorFromWorkloadPrincipal(principal);
    expect(actor.tenantId).toBe("tnt_1");
    expect(actor.actorType).toBe("workload");
    expect(actor.actorId).toBe("inv_1");
  });

  it("workload 缺失 invocationId 抛错", () => {
    const principal = buildWorkloadPrincipal("tnt_1", "inv_1");
    principal.invocationId = null;
    expect(() => actorFromWorkloadPrincipal(principal)).toThrow(/缺失 invocationId/);
  });
});

// ─── audit-queries（DB）─────────────────────────────────

describe("audit-queries", () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
  });

  it("appendAuditEvent 写入并返回记录", async () => {
    const event = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      beforeHash: null,
      afterHash: "hash_after",
      reason: "首次发布",
      requestId: "req_1",
    });
    expect(event.id).toBeDefined();
    expect(event.tenantId).toBe(tenantId);
    expect(event.actorType).toBe("user");
    expect(event.actorId).toBe("uid_1");
    expect(event.actionType).toBe("agent.publish");
    expect(event.targetType).toBe("agent");
    expect(event.targetId).toBe("agt_1");
    expect(event.beforeHash).toBeNull();
    expect(event.afterHash).toBe("hash_after");
    expect(event.reason).toBe("首次发布");
    expect(event.requestId).toBe("req_1");
    expect(event.occurredAt).toBeInstanceOf(Date);
  });

  it("appendAuditEvent 默认值：targetId/beforeHash/afterHash/reason 为 null", async () => {
    const event = await appendAuditEvent({
      tenantId,
      actorType: "system",
      actorId: "event_projection",
      actionType: "event.quarantine.resolve",
      targetType: "event",
      requestId: "req_2",
    });
    expect(event.targetId).toBeNull();
    expect(event.beforeHash).toBeNull();
    expect(event.afterHash).toBeNull();
    expect(event.reason).toBeNull();
  });

  it("appendAuditEvent 自定义 occurredAt 被保留", async () => {
    const customTime = new Date("2026-01-01T00:00:00Z");
    const event = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "policy.publish",
      targetType: "policy",
      requestId: "req_3",
      occurredAt: customTime,
    });
    expect(event.occurredAt).toEqual(customTime);
  });

  it("getAuditEventById 存在时返回记录", async () => {
    const created = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "route.update",
      targetType: "route",
      targetId: "rt_1",
      requestId: "req_4",
    });
    const found = await getAuditEventById(created.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.actionType).toBe("route.update");
  });

  it("getAuditEventById 不存在返回 null", async () => {
    const found = await getAuditEventById("missing-id");
    expect(found).toBeNull();
  });

  it("listAuditEvents 空过滤返回所有租户事件", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      requestId: "req_a",
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_2",
      actionType: "route.update",
      targetType: "route",
      targetId: "rt_1",
      requestId: "req_b",
    });
    const list = await listAuditEvents({ tenantId });
    expect(list).toHaveLength(2);
  });

  it("listAuditEvents 按 actorType 过滤", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_a",
    });
    await appendAuditEvent({
      tenantId,
      actorType: "system",
      actorId: "event_projection",
      actionType: "event.quarantine.resolve",
      targetType: "event",
      requestId: "req_b",
    });
    const list = await listAuditEvents({ tenantId, actorType: "system" });
    expect(list).toHaveLength(1);
    expect(list[0]?.actorType).toBe("system");
  });

  it("listAuditEvents 按 actorId 过滤", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_a",
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_2",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_b",
    });
    const list = await listAuditEvents({ tenantId, actorId: "uid_1" });
    expect(list).toHaveLength(1);
    expect(list[0]?.actorId).toBe("uid_1");
  });

  it("listAuditEvents 按 actionType 过滤", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_a",
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_2",
      actionType: "route.update",
      targetType: "route",
      requestId: "req_b",
    });
    const list = await listAuditEvents({ tenantId, actionType: "agent.publish" });
    expect(list).toHaveLength(1);
    expect(list[0]?.actionType).toBe("agent.publish");
  });

  it("listAuditEvents 按 targetType + targetId 过滤", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      requestId: "req_a",
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_2",
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_2",
      requestId: "req_b",
    });
    const list = await listAuditEvents({
      tenantId,
      targetType: "agent",
      targetId: "agt_1",
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.targetId).toBe("agt_1");
  });

  it("listAuditEvents 按时间范围过滤（occurredFrom/occurredTo 包含边界）", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-02T00:00:00Z");
    const t2 = new Date("2026-01-03T00:00:00Z");
    const t3 = new Date("2026-01-04T00:00:00Z");
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_a",
      occurredAt: t0,
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_b",
      occurredAt: t2,
    });
    // [t1, t3] 应仅包含 t2
    const list = await listAuditEvents({
      tenantId,
      occurredFrom: t1,
      occurredTo: t3,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.occurredAt).toEqual(t2);
  });

  it("listAuditEvents 按 occurredAt 升序排序", async () => {
    const t0 = new Date("2026-03-01T00:00:00Z");
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-02-01T00:00:00Z");
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_a",
      occurredAt: t0,
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_b",
      occurredAt: t1,
    });
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_c",
      occurredAt: t2,
    });
    const list = await listAuditEvents({ tenantId });
    expect(list).toHaveLength(3);
    expect(list[0]?.occurredAt).toEqual(t1);
    expect(list[1]?.occurredAt).toEqual(t2);
    expect(list[2]?.occurredAt).toEqual(t0);
  });

  it("listAuditEvents limit 默认 100，最大 500（截断）", async () => {
    // 写入 5 条
    for (let i = 0; i < 5; i++) {
      await appendAuditEvent({
        tenantId,
        actorType: "user",
        actorId: "uid_1",
        actionType: "agent.publish",
        targetType: "agent",
        requestId: `req_${i}`,
      });
    }
    // limit=2 截断
    const list = await listAuditEvents({ tenantId, limit: 2 });
    expect(list).toHaveLength(2);
    // limit=10000 截断为 500
    expect(await listAuditEvents({ tenantId, limit: 10000 })).toHaveLength(5); // 仅 5 条，未达 500 上限
  });

  it("listAuditEvents 跨租户隔离（tenantId 必填，不返回其他租户事件）", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_a",
    });
    // 用其他 tenantId 查询（不会因 FK 校验失败，因为只查 AuditEvent 表）
    const list = await listAuditEvents({ tenantId: "other-tenant" });
    expect(list).toHaveLength(0);
  });

  it("deleteExpiredAuditEvents 仅清理 olderThan 之前的事件", async () => {
    const oldEvent = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_old",
      occurredAt: new Date("2020-01-01T00:00:00Z"),
    });
    const newEvent = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_new",
      occurredAt: new Date(Date.now() + 60_000),
    });
    const deleted = await deleteExpiredAuditEvents(tenantId, new Date());
    expect(deleted).toBe(1);
    expect(await getAuditEventById(oldEvent.id)).toBeNull();
    expect(await getAuditEventById(newEvent.id)).not.toBeNull();
  });

  it("deleteExpiredAuditEvents 跨租户隔离", async () => {
    await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      requestId: "req_old",
      occurredAt: new Date("2020-01-01T00:00:00Z"),
    });
    // 用其他 tenantId 清理，应不影响当前租户
    const deleted = await deleteExpiredAuditEvents("other-tenant", new Date());
    expect(deleted).toBe(0);
    const list = await listAuditEvents({ tenantId });
    expect(list.length).toBeGreaterThan(0);
  });
});

// ─── recordAuditEvent / recordSystemAuditEvent（守卫，DB）───

describe("recordAuditEvent", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
    const identity = await seedCaller(tenantId, "user-001", "user001@example.com");
    userIdentityId = identity.id;
  });

  it("已知动作 + before/after 内容 → 计算 hash 写入", async () => {
    const before = { name: "v1", description: "old" };
    const after = { name: "v2", description: "new" };
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      before,
      after,
      reason: "升级到 v2",
      requestId: "req_audit_1",
    });
    expect(event.actionType).toBe("agent.publish");
    expect(event.beforeHash).toBe(computeContentHash(before));
    expect(event.afterHash).toBe(computeContentHash(after));
    expect(event.reason).toBe("升级到 v2");
    expect(event.requestId).toBe("req_audit_1");
  });

  it("创建操作（仅 after）→ beforeHash=null, afterHash 计算", async () => {
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "agent.revision.create",
      targetType: "agent_revision",
      targetId: null,
      after: { id: "rev_1", version: "v1" },
      requestId: "req_audit_2",
    });
    expect(event.beforeHash).toBeNull();
    expect(event.afterHash).not.toBeNull();
    expect(event.targetId).toBeNull();
  });

  it("删除操作（仅 before）→ beforeHash 计算, afterHash=null", async () => {
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "deletion.request",
      targetType: "thread",
      targetId: "thr_1",
      before: { id: "thr_1", title: "to be deleted" },
      requestId: "req_audit_3",
    });
    expect(event.beforeHash).not.toBeNull();
    expect(event.afterHash).toBeNull();
  });

  it("显式 beforeHash 优先于 before 内容", async () => {
    const explicitHash = "0".repeat(64);
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "policy.publish",
      targetType: "policy",
      targetId: "pol_1",
      before: { irrelevant: "should be ignored" },
      beforeHash: explicitHash,
      after: { v: 2 },
      requestId: "req_audit_4",
    });
    expect(event.beforeHash).toBe(explicitHash);
    expect(event.afterHash).toBe(computeContentHash({ v: 2 }));
  });

  it("显式 afterHash=null 优先于 after 内容（删除语义）", async () => {
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "deletion.request",
      targetType: "thread",
      targetId: "thr_1",
      after: { should: "be ignored" },
      afterHash: null,
      requestId: "req_audit_5",
    });
    expect(event.afterHash).toBeNull();
  });

  it("requestId 缺省时平台生成", async () => {
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "route.update",
      targetType: "route",
      targetId: "rt_1",
      after: { weight: 100 },
    });
    expect(event.requestId).toBeDefined();
    expect(event.requestId.length).toBeGreaterThan(0);
  });

  it("occurredAt 缺省时使用当前时间", async () => {
    const before = new Date();
    const event = await recordAuditEvent({
      actor: { tenantId, actorType: "user", actorId: userIdentityId },
      actionType: "route.update",
      targetType: "route",
      targetId: "rt_1",
      after: { weight: 100 },
    });
    const after = new Date();
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("未知动作 → 抛 AuditActionTypeError，不写入记录", async () => {
    await expect(
      recordAuditEvent({
        actor: { tenantId, actorType: "user", actorId: userIdentityId },
        actionType: "evil.action",
        targetType: "agent",
        targetId: "agt_1",
      }),
    ).rejects.toThrow(AuditActionTypeError);
    const list = await listAuditEvents({ tenantId });
    expect(list).toHaveLength(0);
  });

  it("actor 从 Principal 提取（actorFromPrincipal）写入 user 类型", async () => {
    const principal = buildPrincipal(tenantId, userIdentityId);
    const actor = actorFromPrincipal(principal);
    const event = await recordAuditEvent({
      actor,
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      after: { v: 2 },
    });
    expect(event.actorType).toBe("user");
    expect(event.actorId).toBe(userIdentityId);
    expect(event.tenantId).toBe(tenantId);
  });

  it("service Token 身份写入 service 类型", async () => {
    const servicePrincipal = buildServicePrincipal(tenantId, "cicd");
    const actor = actorFromWorkloadPrincipal(servicePrincipal);
    const event = await recordAuditEvent({
      actor,
      actionType: "artifact.attestation.verify",
      targetType: "artifact",
      targetId: "art_1",
      after: { verified: true },
    });
    expect(event.actorType).toBe("service");
    expect(event.actorId).toBe("cicd");
  });

  it("runtime workload Token 身份写入 workload 类型", async () => {
    const workloadPrincipal = buildWorkloadPrincipal(tenantId, "inv_01");
    const actor = actorFromWorkloadPrincipal(workloadPrincipal);
    const event = await recordAuditEvent({
      actor,
      actionType: "job.cancel",
      targetType: "job",
      targetId: "job_1",
      reason: "Runtime 主动取消",
    });
    expect(event.actorType).toBe("workload");
    expect(event.actorId).toBe("inv_01");
  });

  it("所有已知动作类型均可成功写入", async () => {
    for (const actionType of AUDIT_ACTION_TYPES) {
      await recordAuditEvent({
        actor: { tenantId, actorType: "user", actorId: userIdentityId },
        actionType,
        targetType: "test_target",
        targetId: `tid_${actionType}`,
      });
    }
    const list = await listAuditEvents({ tenantId });
    expect(list).toHaveLength(AUDIT_ACTION_TYPES.length);
  });
});

describe("recordSystemAuditEvent", () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
  });

  it("写入 actorType=system，actorId=systemComponent", async () => {
    const event = await recordSystemAuditEvent({
      tenantId,
      systemComponent: "event_projection",
      actionType: "event.quarantine.resolve",
      targetType: "event",
      targetId: "evt_1",
      reason: "隔离事件自动处置",
    });
    expect(event.actorType).toBe("system");
    expect(event.actorId).toBe("event_projection");
    expect(event.tenantId).toBe(tenantId);
    expect(event.actionType).toBe("event.quarantine.resolve");
  });

  it("retention_scheduler 写入 deletion.request", async () => {
    const event = await recordSystemAuditEvent({
      tenantId,
      systemComponent: "retention_scheduler",
      actionType: "deletion.request",
      targetType: "thread",
      targetId: "thr_old_1",
      reason: "达到保留期上限",
    });
    expect(event.actorType).toBe("system");
    expect(event.actorId).toBe("retention_scheduler");
  });

  it("未知动作 → 抛 AuditActionTypeError", async () => {
    await expect(
      recordSystemAuditEvent({
        tenantId,
        systemComponent: "bad_component",
        actionType: "evil.system.action",
        targetType: "agent",
      }),
    ).rejects.toThrow(AuditActionTypeError);
  });

  it("显式 hash 透传", async () => {
    const beforeHash = "a".repeat(64);
    const afterHash = "b".repeat(64);
    const event = await recordSystemAuditEvent({
      tenantId,
      systemComponent: "event_projection",
      actionType: "event.quarantine.resolve",
      targetType: "event",
      targetId: "evt_1",
      beforeHash,
      afterHash,
    });
    expect(event.beforeHash).toBe(beforeHash);
    expect(event.afterHash).toBe(afterHash);
  });
});

// ─── 审计不可修改语义（append-only）────────────────────────

describe("审计账本不可修改语义", () => {
  let tenantId: string;

  beforeEach(async () => {
    const tenant = await ensureDefaultTenant();
    tenantId = tenant.id;
  });

  it("audit-queries 模块不导出 update/delete 函数（仅 append/get/list/deleteExpired）", async () => {
    // 静态契约检查：模块导出符合只追加语义
    const module = await import("@/lib/identity/audit-queries");
    expect(typeof module.appendAuditEvent).toBe("function");
    expect(typeof module.getAuditEventById).toBe("function");
    expect(typeof module.listAuditEvents).toBe("function");
    expect(typeof module.deleteExpiredAuditEvents).toBe("function");
    // 不应存在 updateAuditEvent / deleteAuditEvent / updateAuditEventById 等修改函数
    expect(module).not.toHaveProperty("updateAuditEvent");
    expect(module).not.toHaveProperty("deleteAuditEvent");
    expect(module).not.toHaveProperty("updateAuditEventById");
    expect(module).not.toHaveProperty("deleteAuditEventById");
  });

  it("重复 append 产生独立 id（不可修改已有事件）", async () => {
    const event1 = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      requestId: "req_1",
    });
    const event2 = await appendAuditEvent({
      tenantId,
      actorType: "user",
      actorId: "uid_1",
      actionType: "agent.publish",
      targetType: "agent",
      targetId: "agt_1",
      requestId: "req_1",
    });
    expect(event1.id).not.toBe(event2.id);
    const list: AuditEvent[] = await listAuditEvents({ tenantId });
    expect(list).toHaveLength(2);
  });
});
