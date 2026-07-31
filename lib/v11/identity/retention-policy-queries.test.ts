/**
 * S12-W06：V11 数据保留策略仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - validateRetentionDays / parseRetentionDays：校验与解析（含 "permanent"）。
 * - createRetentionPolicy：创建策略（写审计 legal_hold.manage）；唯一性约束。
 * - getRetentionPolicy / getRetentionPolicyById：查询；跨租户隔离。
 * - updateRetentionPolicy：更新策略（写审计 before/after）。
 * - deleteRetentionPolicy：删除策略（写审计 before）。
 * - listRetentionPolicies：cursor 分页；dataClass / objectType 过滤。
 * - resolveRetentionDays / resolveLegalHoldRetentionDays：解析引擎（显式策略 → 默认值）。
 * - isRetentionExpired：保留期判断（结合 Legal Hold 窗口）。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/v11/identity/audit";
import { listAuditEvents } from "@/lib/v11/identity/audit-queries";
import {
  DEFAULT_RETENTION_DAYS,
  RetentionPolicyError as RetentionPolicyErrorClass,
  createRetentionPolicy,
  deleteRetentionPolicy,
  getRetentionPolicy,
  getRetentionPolicyById,
  isRetentionExpired,
  listRetentionPolicies,
  parseRetentionDays,
  resolveLegalHoldRetentionDays,
  resolveRetentionDays,
  updateRetentionPolicy,
  validateRetentionDays,
} from "@/lib/v11/identity/retention-policy-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { tenant } from "@/lib/v11/schema/identity";
import {
  RETENTION_OBJECT_TYPES,
  type RetentionObjectType,
} from "@/lib/v11/schema/retention-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助 ──────────────────────────────────────────────────

function buildActor(tenantId: string): AuditActor {
  return {
    tenantId,
    actorType: "user",
    actorId: "admin-001",
  };
}

function buildCreateParams(opts: {
  tenantId: string;
  objectType?: RetentionObjectType;
  retentionDays?: string;
  legalHoldDays?: string;
  dataClass?: string;
}) {
  return {
    tenantId: opts.tenantId,
    objectType: opts.objectType ?? ("audit" as const),
    retentionDays: opts.retentionDays ?? "365",
    legalHoldDays: opts.legalHoldDays,
    dataClass: opts.dataClass ?? "operational",
    statutoryRequirements: "GDPR Article 30",
    description: "测试保留策略",
    createdBy: "admin-001",
    actor: buildActor(opts.tenantId),
  };
}

/** seed 一个额外租户（用于跨租户隔离测试）。 */
async function seedExtraTenant(tenantId: string, key: string): Promise<void> {
  await db.insert(tenant).values({
    id: tenantId,
    key,
    name: `Extra Tenant ${key}`,
    status: "active",
  });
}

const EXTRA_TENANT_ID = "00000000-0000-4000-8000-000000000001";

// ═══════════════════════════════════════════════════════════
// 1. validateRetentionDays / parseRetentionDays
// ═══════════════════════════════════════════════════════════

describe("V11 validateRetentionDays / parseRetentionDays", () => {
  it("validateRetentionDays 接受正整数", () => {
    expect(() => validateRetentionDays("1")).not.toThrow();
    expect(() => validateRetentionDays("365")).not.toThrow();
    expect(() => validateRetentionDays("99999")).not.toThrow();
  });

  it("validateRetentionDays 接受 permanent", () => {
    expect(() => validateRetentionDays("permanent")).not.toThrow();
  });

  it("validateRetentionDays 拒绝非正整数", () => {
    expect(() => validateRetentionDays("0")).toThrow(RetentionPolicyErrorClass);
    expect(() => validateRetentionDays("-1")).toThrow(RetentionPolicyErrorClass);
    expect(() => validateRetentionDays("1.5")).toThrow(RetentionPolicyErrorClass);
    expect(() => validateRetentionDays("abc")).toThrow(RetentionPolicyErrorClass);
    expect(() => validateRetentionDays("")).toThrow(RetentionPolicyErrorClass);
  });

  it("parseRetentionDays 返回正整数", () => {
    expect(parseRetentionDays("1")).toBe(1);
    expect(parseRetentionDays("365")).toBe(365);
  });

  it('parseRetentionDays "permanent" 返回 Infinity', () => {
    expect(parseRetentionDays("permanent")).toBe(Number.POSITIVE_INFINITY);
  });

  it("parseRetentionDays 拒绝非正整数抛错", () => {
    expect(() => parseRetentionDays("0")).toThrow(RetentionPolicyErrorClass);
    expect(() => parseRetentionDays("abc")).toThrow(RetentionPolicyErrorClass);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. createRetentionPolicy
// ═══════════════════════════════════════════════════════════

describe("V11 createRetentionPolicy", () => {
  it("创建策略并返回完整字段", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    expect(policy.id).toBeDefined();
    expect(policy.tenantId).toBe(t.id);
    expect(policy.objectType).toBe("audit");
    expect(policy.retentionDays).toBe("365");
    expect(policy.legalHoldDays).toBeNull();
    expect(policy.dataClass).toBe("operational");
    expect(policy.statutoryRequirements).toBe("GDPR Article 30");
    expect(policy.description).toBe("测试保留策略");
    expect(policy.createdBy).toBe("admin-001");
    expect(policy.updatedBy).toBe("admin-001");
    expect(policy.createdAt).toBeInstanceOf(Date);
    expect(policy.updatedAt).toBeInstanceOf(Date);
  });

  it("创建策略时写入审计事件 legal_hold.manage", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "legal_hold.manage",
      targetType: "retention_policy",
      targetId: policy.id,
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("user");
    expect(event?.actorId).toBe("admin-001");
    expect(event?.afterHash).toBeTruthy();
  });

  it("唯一性约束：同一 (tenantId, objectType) 重复创建抛 policy_already_exists", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "thread" }));

    await expect(
      createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "thread" })),
    ).rejects.toMatchObject({ code: "policy_already_exists" });
  });

  it("不同 objectType 可在同一 tenant 共存", async () => {
    const t = await ensureDefaultTenant();
    const a = await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "thread" }),
    );
    const b = await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "event" }),
    );
    expect(a.id).not.toBe(b.id);
    expect(a.objectType).toBe("thread");
    expect(b.objectType).toBe("event");
  });

  it("非法 retentionDays 抛 invalid_retention_days", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      createRetentionPolicy(buildCreateParams({ tenantId: t.id, retentionDays: "0" })),
    ).rejects.toMatchObject({ code: "invalid_retention_days" });
    await expect(
      createRetentionPolicy(buildCreateParams({ tenantId: t.id, retentionDays: "abc" })),
    ).rejects.toMatchObject({ code: "invalid_retention_days" });
  });

  it("非法 legalHoldDays 抛 invalid_retention_days", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      createRetentionPolicy(buildCreateParams({ tenantId: t.id, legalHoldDays: "0" })),
    ).rejects.toMatchObject({ code: "invalid_retention_days" });
  });

  it("permanent 保留天数可创建", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, retentionDays: "permanent" }),
    );
    expect(policy.retentionDays).toBe("permanent");
  });

  it("legalHoldDays 透传到记录", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, legalHoldDays: "30" }),
    );
    expect(policy.legalHoldDays).toBe("30");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getRetentionPolicy / getRetentionPolicyById
// ═══════════════════════════════════════════════════════════

describe("V11 getRetentionPolicy / getRetentionPolicyById", () => {
  it("getRetentionPolicy 按 tenantId+objectType 查询", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "audit" }));

    const found = await getRetentionPolicy(t.id, "audit");
    expect(found).not.toBeNull();
    expect(found?.objectType).toBe("audit");
  });

  it("getRetentionPolicy 不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getRetentionPolicy(t.id, "audit");
    expect(found).toBeNull();
  });

  it("getRetentionPolicyById 按 id 查询", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    const found = await getRetentionPolicyById(t.id, policy.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(policy.id);
  });

  it("getRetentionPolicyById 跨租户隔离", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    // 用不同 tenantId 查询同一 id 应返回 null
    const found = await getRetentionPolicyById(EXTRA_TENANT_ID, policy.id);
    expect(found).toBeNull();
  });

  it("getRetentionPolicy 跨租户隔离", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "audit" }));

    // 在 EXTRA_TENANT 上不应查询到 t 的策略
    const found = await getRetentionPolicy(EXTRA_TENANT_ID, "audit");
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. updateRetentionPolicy
// ═══════════════════════════════════════════════════════════

describe("V11 updateRetentionPolicy", () => {
  it("更新 retentionDays 并写审计 before/after", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    const updated = await updateRetentionPolicy({
      tenantId: t.id,
      id: policy.id,
      retentionDays: "730",
      updatedBy: "admin-002",
      actor: buildActor(t.id),
    });

    expect(updated.retentionDays).toBe("730");
    expect(updated.updatedBy).toBe("admin-002");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(policy.updatedAt.getTime());

    // 校验审计事件
    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "legal_hold.manage",
      targetType: "retention_policy",
      targetId: policy.id,
    });
    // 创建 + 更新两条审计事件
    expect(events.length).toBe(2);
    // 最后一条是更新事件（按 occurredAt 升序）
    const updateEvent = events[1];
    expect(updateEvent?.beforeHash).toBeTruthy();
    expect(updateEvent?.afterHash).toBeTruthy();
  });

  it("更新 legalHoldDays（含置 null）", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, legalHoldDays: "30" }),
    );
    expect(policy.legalHoldDays).toBe("30");

    const updated = await updateRetentionPolicy({
      tenantId: t.id,
      id: policy.id,
      legalHoldDays: null,
      updatedBy: "admin-001",
      actor: buildActor(t.id),
    });
    expect(updated.legalHoldDays).toBeNull();
  });

  it("更新不存在的策略抛 policy_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      updateRetentionPolicy({
        tenantId: t.id,
        id: "non-existent-id",
        retentionDays: "365",
        updatedBy: "admin-001",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "policy_not_found" });
  });

  it("更新非法 retentionDays 抛 invalid_retention_days", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    await expect(
      updateRetentionPolicy({
        tenantId: t.id,
        id: policy.id,
        retentionDays: "0",
        updatedBy: "admin-001",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "invalid_retention_days" });
  });

  it("跨租户更新失败（policy_not_found）", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    await expect(
      updateRetentionPolicy({
        tenantId: EXTRA_TENANT_ID,
        id: policy.id,
        retentionDays: "730",
        updatedBy: "admin-001",
        actor: buildActor(EXTRA_TENANT_ID),
      }),
    ).rejects.toMatchObject({ code: "policy_not_found" });
  });
});

// ═══════════════════════════════════════════════════════════
// 5. deleteRetentionPolicy
// ═══════════════════════════════════════════════════════════

describe("V11 deleteRetentionPolicy", () => {
  it("删除策略并写审计 before", async () => {
    const t = await ensureDefaultTenant();
    const policy = await createRetentionPolicy(buildCreateParams({ tenantId: t.id }));

    await deleteRetentionPolicy({
      tenantId: t.id,
      id: policy.id,
      deletedBy: "admin-001",
      actor: buildActor(t.id),
    });

    // 删除后查询返回 null
    const found = await getRetentionPolicyById(t.id, policy.id);
    expect(found).toBeNull();

    // 审计事件：创建 + 删除两条
    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "legal_hold.manage",
      targetType: "retention_policy",
      targetId: policy.id,
    });
    expect(events.length).toBe(2);
    // 最后一条是删除事件
    const deleteEvent = events[1];
    expect(deleteEvent?.beforeHash).toBeTruthy();
  });

  it("删除不存在的策略抛 policy_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      deleteRetentionPolicy({
        tenantId: t.id,
        id: "non-existent-id",
        deletedBy: "admin-001",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "policy_not_found" });
  });
});

// ═══════════════════════════════════════════════════════════
// 6. listRetentionPolicies（cursor 分页）
// ═══════════════════════════════════════════════════════════

describe("V11 listRetentionPolicies", () => {
  it("按 createdAt 升序返回", async () => {
    const t = await ensureDefaultTenant();
    // 创建多条策略（不同 objectType 保证唯一）
    const objectTypes: RetentionObjectType[] = ["audit", "thread", "event"];
    for (const ot of objectTypes) {
      await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: ot }));
      // 错开 createdAt（fsp=3 ms 级）
      await new Promise((r) => setTimeout(r, 5));
    }

    const page = await listRetentionPolicies({ tenantId: t.id });
    expect(page.items.length).toBe(3);
    // 升序
    expect(page.items[0]?.objectType).toBe("audit");
    expect(page.items[2]?.objectType).toBe("event");
    expect(page.nextCursor).toBeNull();
  });

  it("limit 截断 + nextCursor 返回", async () => {
    const t = await ensureDefaultTenant();
    const objectTypes: RetentionObjectType[] = ["audit", "thread", "event", "trace", "memory"];
    for (const ot of objectTypes) {
      await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: ot }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listRetentionPolicies({ tenantId: t.id, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listRetentionPolicies({
      tenantId: t.id,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.length).toBe(2);
    // 第二页的第一项应是第三条记录（event）
    expect(page2.items[0]?.objectType).toBe("event");
  });

  it("dataClass 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", dataClass: "pii" }),
    );
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "thread", dataClass: "operational" }),
    );

    const page = await listRetentionPolicies({ tenantId: t.id, dataClass: "pii" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.objectType).toBe("audit");
    expect(page.items[0]?.dataClass).toBe("pii");
  });

  it("objectType 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "audit" }));
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "thread" }));

    const page = await listRetentionPolicies({ tenantId: t.id, objectType: "thread" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.objectType).toBe("thread");
  });

  it("跨租户隔离：仅返回当前租户的策略", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "audit" }));
    await createRetentionPolicy(
      buildCreateParams({ tenantId: EXTRA_TENANT_ID, objectType: "audit" }),
    );

    const pageT = await listRetentionPolicies({ tenantId: t.id });
    const pageExtra = await listRetentionPolicies({ tenantId: EXTRA_TENANT_ID });
    expect(pageT.items.length).toBe(1);
    expect(pageExtra.items.length).toBe(1);
    expect(pageT.items[0]?.tenantId).toBe(t.id);
    expect(pageExtra.items[0]?.tenantId).toBe(EXTRA_TENANT_ID);
  });

  it("空结果 nextCursor 为 null", async () => {
    const t = await ensureDefaultTenant();
    const page = await listRetentionPolicies({ tenantId: t.id });
    expect(page.items.length).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 7. resolveRetentionDays / resolveLegalHoldRetentionDays
// ═══════════════════════════════════════════════════════════

describe("V11 resolveRetentionDays", () => {
  it("显式策略优先于默认值", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", retentionDays: "100" }),
    );

    const days = await resolveRetentionDays(t.id, "audit");
    expect(days).toBe(100);
  });

  it("无策略时返回 DEFAULT_RETENTION_DAYS 默认值", async () => {
    const t = await ensureDefaultTenant();
    for (const ot of RETENTION_OBJECT_TYPES) {
      const days = await resolveRetentionDays(t.id, ot);
      expect(days).toBe(DEFAULT_RETENTION_DAYS[ot]);
    }
  });

  it("permanent 策略返回 Infinity", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", retentionDays: "permanent" }),
    );
    const days = await resolveRetentionDays(t.id, "audit");
    expect(days).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("V11 resolveLegalHoldRetentionDays", () => {
  it("策略含 legalHoldDays 返回解析值", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({
        tenantId: t.id,
        objectType: "audit",
        legalHoldDays: "60",
      }),
    );
    const days = await resolveLegalHoldRetentionDays(t.id, "audit");
    expect(days).toBe(60);
  });

  it("策略无 legalHoldDays 返回 0", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(buildCreateParams({ tenantId: t.id, objectType: "audit" }));
    const days = await resolveLegalHoldRetentionDays(t.id, "audit");
    expect(days).toBe(0);
  });

  it("无策略返回 0", async () => {
    const t = await ensureDefaultTenant();
    const days = await resolveLegalHoldRetentionDays(t.id, "audit");
    expect(days).toBe(0);
  });

  it("legalHoldDays=permanent 返回 Infinity", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({
        tenantId: t.id,
        objectType: "audit",
        legalHoldDays: "permanent",
      }),
    );
    const days = await resolveLegalHoldRetentionDays(t.id, "audit");
    expect(days).toBe(Number.POSITIVE_INFINITY);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. isRetentionExpired
// ═══════════════════════════════════════════════════════════

describe("V11 isRetentionExpired", () => {
  it("无策略：createdAt + 默认保留期 < now → true", async () => {
    const t = await ensureDefaultTenant();
    // audit 默认 7 年；用 8 年前的 createdAt
    const createdAt = new Date(Date.now() - 8 * 365 * 24 * 60 * 60 * 1000);
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      now: new Date(),
    });
    expect(expired).toBe(true);
  });

  it("无策略：createdAt + 默认保留期 > now → false", async () => {
    const t = await ensureDefaultTenant();
    const createdAt = new Date(); // 今天
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      now: new Date(),
    });
    expect(expired).toBe(false);
  });

  it("显式策略：超过 retentionDays → true", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", retentionDays: "30" }),
    );
    const createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      now: new Date(),
    });
    expect(expired).toBe(true);
  });

  it("显式策略：未超过 retentionDays → false", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", retentionDays: "30" }),
    );
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      now: new Date(),
    });
    expect(expired).toBe(false);
  });

  it("permanent 策略永不过期", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", retentionDays: "permanent" }),
    );
    const createdAt = new Date(Date.now() - 100 * 365 * 24 * 60 * 60 * 1000);
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      now: new Date(),
    });
    expect(expired).toBe(false);
  });

  it("有 Legal Hold 解除：取 retentionDays 和 legalHoldDays 较晚截止", async () => {
    const t = await ensureDefaultTenant();
    // retentionDays=30，legalHoldDays=60
    await createRetentionPolicy(
      buildCreateParams({
        tenantId: t.id,
        objectType: "audit",
        retentionDays: "30",
        legalHoldDays: "60",
      }),
    );
    const createdAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 天前创建
    // 10 天前解除 Legal Hold
    const releasedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    // retentionDeadline = createdAt + 30d = 10 天前（已过）
    // holdDeadline = releasedAt + 60d = 50 天后（未过）
    // effectiveDeadline = max(retentionDeadline, holdDeadline) = holdDeadline → 未过
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      releasedAt,
      now: new Date(),
    });
    expect(expired).toBe(false);
  });

  it("有 Legal Hold 解除且 legalHoldDays=permanent 永不过期", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({
        tenantId: t.id,
        objectType: "audit",
        retentionDays: "30",
        legalHoldDays: "permanent",
      }),
    );
    const createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const releasedAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);

    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      releasedAt,
      now: new Date(),
    });
    expect(expired).toBe(false);
  });

  it("有 Legal Hold 解除：两者都过 → true", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({
        tenantId: t.id,
        objectType: "audit",
        retentionDays: "30",
        legalHoldDays: "60",
      }),
    );
    // 200 天前创建
    const createdAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    // 100 天前解除 Legal Hold
    const releasedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

    // retentionDeadline = createdAt + 30d = 170 天前（已过）
    // holdDeadline = releasedAt + 60d = 40 天前（已过）
    // effectiveDeadline = max = 40 天前 → 已过
    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      releasedAt,
      now: new Date(),
    });
    expect(expired).toBe(true);
  });

  it("有 Legal Hold 解除：仅 releasedAt 字段为 null 时按 retentionDays 判断", async () => {
    const t = await ensureDefaultTenant();
    await createRetentionPolicy(
      buildCreateParams({ tenantId: t.id, objectType: "audit", retentionDays: "30" }),
    );
    const createdAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    const expired = await isRetentionExpired({
      tenantId: t.id,
      objectType: "audit",
      createdAt,
      releasedAt: null,
      now: new Date(),
    });
    expect(expired).toBe(true);
  });
});
