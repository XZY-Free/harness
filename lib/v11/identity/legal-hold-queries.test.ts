/**
 * S12-W06：V11 Legal Hold 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createLegalHold：创建 Hold（写审计 legal_hold.manage）；唯一性；双人审批；有效期校验。
 * - releaseLegalHold：解除 Hold（写审计 before/after）；已解除抛错；不存在抛错。
 * - getLegalHoldById / getLegalHoldByTarget / getActiveLegalHold：查询；跨租户隔离。
 * - isLegalHoldActive：active 且未过期阻止删除；过期 Hold 不阻止。
 * - listLegalHolds：cursor 分页；targetType / holdState 过滤。
 * - listExpiredActiveHolds：列出过期但未解除的 Hold。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  createLegalHold,
  getActiveLegalHold,
  getLegalHoldById,
  getLegalHoldByTarget,
  isLegalHoldActive,
  listExpiredActiveHolds,
  listLegalHolds,
  releaseLegalHold,
} from "@/lib/v11/identity/legal-hold-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { tenant } from "@/lib/v11/schema/identity";
import {
  type LegalHoldTargetType,
  type V11LegalHold,
  v11LegalHold,
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
  targetType?: LegalHoldTargetType;
  targetId?: string;
  createdBy?: string;
  approvedBy?: string;
  validUntil?: Date;
}) {
  return {
    tenantId: opts.tenantId,
    targetType: opts.targetType ?? ("thread" as const),
    targetId: opts.targetId ?? "thread-001",
    reason: "诉讼保留",
    createdBy: opts.createdBy ?? "admin-001",
    approvedBy: opts.approvedBy ?? "approver-001",
    validUntil: opts.validUntil ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30d 后
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
// 1. createLegalHold
// ═══════════════════════════════════════════════════════════

describe("V11 createLegalHold", () => {
  it("创建 Hold 并返回完整字段", async () => {
    const t = await ensureDefaultTenant();
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id, validUntil }));

    expect(hold.id).toBeDefined();
    expect(hold.tenantId).toBe(t.id);
    expect(hold.targetType).toBe("thread");
    expect(hold.targetId).toBe("thread-001");
    expect(hold.holdState).toBe("active");
    expect(hold.reason).toBe("诉讼保留");
    expect(hold.createdBy).toBe("admin-001");
    expect(hold.approvedBy).toBe("approver-001");
    expect(hold.validUntil.toISOString()).toBe(validUntil.toISOString());
    expect(hold.createdAt).toBeInstanceOf(Date);
    expect(hold.releasedAt).toBeNull();
    expect(hold.releasedBy).toBeNull();
    expect(hold.releaseReason).toBeNull();
  });

  it("创建 Hold 时写入审计事件 legal_hold.manage", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id }));

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "legal_hold.manage",
      targetType: "legal_hold",
      targetId: hold.id,
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("user");
    expect(event?.actorId).toBe("admin-001");
    expect(event?.afterHash).toBeTruthy();
  });

  it("唯一性约束：同一 (tenantId, targetType, targetId) 重复创建抛 hold_already_exists", async () => {
    const t = await ensureDefaultTenant();
    await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "thread-x" }));

    await expect(
      createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "thread-x" })),
    ).rejects.toMatchObject({ code: "hold_already_exists" });
  });

  it("不同 target 可在同一 tenant 共存", async () => {
    const t = await ensureDefaultTenant();
    const a = await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "thread-a" }));
    const b = await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "thread-b" }));
    expect(a.id).not.toBe(b.id);
    expect(a.targetId).toBe("thread-a");
    expect(b.targetId).toBe("thread-b");
  });

  it("不同 targetType 同 targetId 可共存（targetType 区分）", async () => {
    const t = await ensureDefaultTenant();
    const a = await createLegalHold(
      buildCreateParams({
        tenantId: t.id,
        targetType: "thread",
        targetId: "shared-id",
      }),
    );
    const b = await createLegalHold(
      buildCreateParams({
        tenantId: t.id,
        targetType: "invocation",
        targetId: "shared-id",
      }),
    );
    expect(a.targetType).toBe("thread");
    expect(b.targetType).toBe("invocation");
  });

  it("双人审批校验：createdBy === approvedBy 抛 invalid_target", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      createLegalHold(
        buildCreateParams({
          tenantId: t.id,
          createdBy: "same-user",
          approvedBy: "same-user",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("有效期校验：validUntil 在过去抛 hold_expired", async () => {
    const t = await ensureDefaultTenant();
    const past = new Date(Date.now() - 60 * 1000);
    await expect(
      createLegalHold(buildCreateParams({ tenantId: t.id, validUntil: past })),
    ).rejects.toMatchObject({ code: "hold_expired" });
  });

  it("有效期校验：validUntil 等于现在抛 hold_expired", async () => {
    const t = await ensureDefaultTenant();
    const now = new Date();
    await expect(
      createLegalHold(buildCreateParams({ tenantId: t.id, validUntil: now })),
    ).rejects.toMatchObject({ code: "hold_expired" });
  });

  it("不同 targetType 均可创建", async () => {
    const t = await ensureDefaultTenant();
    const targetTypes: LegalHoldTargetType[] = [
      "tenant",
      "thread",
      "invocation",
      "job",
      "artifact",
      "agent_revision",
    ];
    for (const tt of targetTypes) {
      const hold = await createLegalHold(
        buildCreateParams({
          tenantId: t.id,
          targetType: tt,
          targetId: `target-${tt}`,
        }),
      );
      expect(hold.targetType).toBe(tt);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 2. releaseLegalHold
// ═══════════════════════════════════════════════════════════

describe("V11 releaseLegalHold", () => {
  it("解除 Hold 并写审计 before/after", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id }));

    const released = await releaseLegalHold({
      tenantId: t.id,
      id: hold.id,
      releasedBy: "admin-002",
      releaseReason: "诉讼结案",
      actor: buildActor(t.id),
    });

    expect(released.id).toBe(hold.id);
    expect(released.holdState).toBe("released");
    expect(released.releasedAt).toBeInstanceOf(Date);
    expect(released.releasedBy).toBe("admin-002");
    expect(released.releaseReason).toBe("诉讼结案");

    // 审计事件：创建 + 解除两条
    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "legal_hold.manage",
      targetType: "legal_hold",
      targetId: hold.id,
    });
    expect(events.length).toBe(2);
    const releaseEvent = events[1];
    expect(releaseEvent?.beforeHash).toBeTruthy();
    expect(releaseEvent?.afterHash).toBeTruthy();
  });

  it("解除不存在的 Hold 抛 hold_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      releaseLegalHold({
        tenantId: t.id,
        id: "non-existent-id",
        releasedBy: "admin-002",
        releaseReason: "test",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "hold_not_found" });
  });

  it("重复解除抛 hold_already_released", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id }));
    await releaseLegalHold({
      tenantId: t.id,
      id: hold.id,
      releasedBy: "admin-002",
      releaseReason: "第一次解除",
      actor: buildActor(t.id),
    });

    await expect(
      releaseLegalHold({
        tenantId: t.id,
        id: hold.id,
        releasedBy: "admin-003",
        releaseReason: "第二次解除",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "hold_already_released" });
  });

  it("跨租户解除失败（hold_not_found）", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id }));

    await expect(
      releaseLegalHold({
        tenantId: EXTRA_TENANT_ID,
        id: hold.id,
        releasedBy: "admin-002",
        releaseReason: "跨租户尝试",
        actor: buildActor(EXTRA_TENANT_ID),
      }),
    ).rejects.toMatchObject({ code: "hold_not_found" });
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getLegalHoldById / getLegalHoldByTarget / getActiveLegalHold
// ═══════════════════════════════════════════════════════════

describe("V11 getLegalHoldById / getLegalHoldByTarget / getActiveLegalHold", () => {
  it("getLegalHoldById 按 id 查询", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id }));

    const found = await getLegalHoldById(t.id, hold.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(hold.id);
  });

  it("getLegalHoldById 不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getLegalHoldById(t.id, "non-existent");
    expect(found).toBeNull();
  });

  it("getLegalHoldByTarget 按 target 查询（含已解除）", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(
      buildCreateParams({ tenantId: t.id, targetId: "thread-target" }),
    );

    const found = await getLegalHoldByTarget(t.id, "thread", "thread-target");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(hold.id);

    // 解除后仍可查到
    await releaseLegalHold({
      tenantId: t.id,
      id: hold.id,
      releasedBy: "admin-002",
      releaseReason: "test",
      actor: buildActor(t.id),
    });
    const foundAfterRelease = await getLegalHoldByTarget(t.id, "thread", "thread-target");
    expect(foundAfterRelease).not.toBeNull();
    expect(foundAfterRelease?.holdState).toBe("released");
  });

  it("getActiveLegalHold 仅返回 active Hold", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(
      buildCreateParams({ tenantId: t.id, targetId: "thread-active" }),
    );

    // 创建后 active 可查
    const active1 = await getActiveLegalHold(t.id, "thread", "thread-active");
    expect(active1).not.toBeNull();
    expect(active1?.id).toBe(hold.id);

    // 解除后 active 不可查
    await releaseLegalHold({
      tenantId: t.id,
      id: hold.id,
      releasedBy: "admin-002",
      releaseReason: "test",
      actor: buildActor(t.id),
    });
    const active2 = await getActiveLegalHold(t.id, "thread", "thread-active");
    expect(active2).toBeNull();
  });

  it("跨租户隔离：getLegalHoldById", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const hold = await createLegalHold(buildCreateParams({ tenantId: t.id }));

    const found = await getLegalHoldById(EXTRA_TENANT_ID, hold.id);
    expect(found).toBeNull();
  });

  it("跨租户隔离：getLegalHoldByTarget", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "thread-cross" }));

    const found = await getLegalHoldByTarget(EXTRA_TENANT_ID, "thread", "thread-cross");
    expect(found).toBeNull();
  });

  it("跨租户隔离：getActiveLegalHold", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "thread-cross" }));

    const found = await getActiveLegalHold(EXTRA_TENANT_ID, "thread", "thread-cross");
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. isLegalHoldActive
// ═══════════════════════════════════════════════════════════

describe("V11 isLegalHoldActive", () => {
  it("无 Hold 返回 false", async () => {
    const t = await ensureDefaultTenant();
    const active = await isLegalHoldActive(t.id, "thread", "thread-none");
    expect(active).toBe(false);
  });

  it("active 且未过期返回 true（阻止删除）", async () => {
    const t = await ensureDefaultTenant();
    await createLegalHold(
      buildCreateParams({
        tenantId: t.id,
        targetId: "thread-blocked",
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    );

    const active = await isLegalHoldActive(t.id, "thread", "thread-blocked");
    expect(active).toBe(true);
  });

  it("已解除的 Hold 返回 false", async () => {
    const t = await ensureDefaultTenant();
    const hold = await createLegalHold(
      buildCreateParams({ tenantId: t.id, targetId: "thread-released" }),
    );
    await releaseLegalHold({
      tenantId: t.id,
      id: hold.id,
      releasedBy: "admin-002",
      releaseReason: "test",
      actor: buildActor(t.id),
    });

    const active = await isLegalHoldActive(t.id, "thread", "thread-released");
    expect(active).toBe(false);
  });

  it("过期的 active Hold 返回 false（不阻止删除）", async () => {
    const t = await ensureDefaultTenant();
    // 直接插入一条已过期的 active Hold（绕过 createLegalHold 的有效期校验）
    const past = new Date(Date.now() - 60 * 1000);
    await db.insert(v11LegalHold).values({
      id: crypto.randomUUID(),
      tenantId: t.id,
      targetType: "thread",
      targetId: "thread-expired",
      holdState: "active",
      reason: "已过期",
      createdBy: "admin-001",
      approvedBy: "approver-001",
      validUntil: past,
    });

    const active = await isLegalHoldActive(t.id, "thread", "thread-expired");
    expect(active).toBe(false);
  });

  it("自定义 now 参数：未来时间点 Hold 视为过期", async () => {
    const t = await ensureDefaultTenant();
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7d 后
    await createLegalHold(
      buildCreateParams({
        tenantId: t.id,
        targetId: "thread-future",
        validUntil,
      }),
    );

    // now 设为 validUntil + 1d，Hold 已过期
    const future = new Date(validUntil.getTime() + 24 * 60 * 60 * 1000);
    const active = await isLegalHoldActive(t.id, "thread", "thread-future", future);
    expect(active).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. listLegalHolds（cursor 分页）
// ═══════════════════════════════════════════════════════════

describe("V11 listLegalHolds", () => {
  it("按 createdAt 升序返回", async () => {
    const t = await ensureDefaultTenant();
    const targetIds = ["t1", "t2", "t3"];
    for (const tid of targetIds) {
      await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: tid }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page = await listLegalHolds({ tenantId: t.id });
    expect(page.items.length).toBe(3);
    expect(page.items[0]?.targetId).toBe("t1");
    expect(page.items[2]?.targetId).toBe("t3");
    expect(page.nextCursor).toBeNull();
  });

  it("limit 截断 + nextCursor 返回", async () => {
    const t = await ensureDefaultTenant();
    const targetIds = ["t1", "t2", "t3", "t4", "t5"];
    for (const tid of targetIds) {
      await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: tid }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listLegalHolds({ tenantId: t.id, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listLegalHolds({
      tenantId: t.id,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.length).toBe(2);
    expect(page2.items[0]?.targetId).toBe("t3");
  });

  it("targetType 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createLegalHold(
      buildCreateParams({ tenantId: t.id, targetType: "thread", targetId: "t-a" }),
    );
    await createLegalHold(
      buildCreateParams({ tenantId: t.id, targetType: "invocation", targetId: "i-a" }),
    );

    const page = await listLegalHolds({ tenantId: t.id, targetType: "thread" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.targetType).toBe("thread");
  });

  it("holdState 过滤", async () => {
    const t = await ensureDefaultTenant();
    const h1 = await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "active-1" }));
    const h2 = await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "to-release" }));
    await releaseLegalHold({
      tenantId: t.id,
      id: h2.id,
      releasedBy: "admin-002",
      releaseReason: "test",
      actor: buildActor(t.id),
    });

    const activePage = await listLegalHolds({ tenantId: t.id, holdState: "active" });
    expect(activePage.items.length).toBe(1);
    expect(activePage.items[0]?.id).toBe(h1.id);

    const releasedPage = await listLegalHolds({ tenantId: t.id, holdState: "released" });
    expect(releasedPage.items.length).toBe(1);
    expect(releasedPage.items[0]?.id).toBe(h2.id);
  });

  it("targetId 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "specific-target" }));
    await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "other-target" }));

    const page = await listLegalHolds({
      tenantId: t.id,
      targetId: "specific-target",
    });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.targetId).toBe("specific-target");
  });

  it("跨租户隔离：仅返回当前租户的 Hold", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createLegalHold(buildCreateParams({ tenantId: t.id, targetId: "t-own" }));
    await createLegalHold(buildCreateParams({ tenantId: EXTRA_TENANT_ID, targetId: "t-extra" }));

    const pageT = await listLegalHolds({ tenantId: t.id });
    const pageExtra = await listLegalHolds({ tenantId: EXTRA_TENANT_ID });
    expect(pageT.items.length).toBe(1);
    expect(pageExtra.items.length).toBe(1);
    expect(pageT.items[0]?.targetId).toBe("t-own");
    expect(pageExtra.items[0]?.targetId).toBe("t-extra");
  });

  it("空结果 nextCursor 为 null", async () => {
    const t = await ensureDefaultTenant();
    const page = await listLegalHolds({ tenantId: t.id });
    expect(page.items.length).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 6. listExpiredActiveHolds
// ═══════════════════════════════════════════════════════════

describe("V11 listExpiredActiveHolds", () => {
  it("返回过期但未解除的 Hold（按 validUntil 升序）", async () => {
    const t = await ensureDefaultTenant();
    // 插入一条过期的 active Hold（绕过 createLegalHold 的有效期校验）
    const past1 = new Date(Date.now() - 2 * 60 * 1000);
    const past2 = new Date(Date.now() - 1 * 60 * 1000);
    await db.insert(v11LegalHold).values({
      id: crypto.randomUUID(),
      tenantId: t.id,
      targetType: "thread",
      targetId: "expired-1",
      holdState: "active",
      reason: "已过期1",
      createdBy: "admin-001",
      approvedBy: "approver-001",
      validUntil: past1,
    });
    await db.insert(v11LegalHold).values({
      id: crypto.randomUUID(),
      tenantId: t.id,
      targetType: "thread",
      targetId: "expired-2",
      holdState: "active",
      reason: "已过期2",
      createdBy: "admin-001",
      approvedBy: "approver-001",
      validUntil: past2,
    });

    const expired = await listExpiredActiveHolds(new Date());
    expect(expired.length).toBeGreaterThanOrEqual(2);
    // 升序
    const expiredIds = expired.map((h: V11LegalHold) => h.targetId);
    expect(expiredIds.indexOf("expired-1")).toBeLessThan(expiredIds.indexOf("expired-2"));
  });

  it("不返回未过期的 active Hold", async () => {
    const t = await ensureDefaultTenant();
    await createLegalHold(
      buildCreateParams({
        tenantId: t.id,
        targetId: "active-valid",
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    );

    const expired = await listExpiredActiveHolds(new Date());
    expect(expired.find((h) => h.targetId === "active-valid")).toBeUndefined();
  });

  it("不返回已解除的过期 Hold", async () => {
    const t = await ensureDefaultTenant();
    const past = new Date(Date.now() - 60 * 1000);
    await db.insert(v11LegalHold).values({
      id: crypto.randomUUID(),
      tenantId: t.id,
      targetType: "thread",
      targetId: "expired-released",
      holdState: "released",
      reason: "已过期且已解除",
      createdBy: "admin-001",
      approvedBy: "approver-001",
      validUntil: past,
      releasedAt: new Date(),
      releasedBy: "admin-002",
      releaseReason: "test",
    });

    const expired = await listExpiredActiveHolds(new Date());
    expect(expired.find((h) => h.targetId === "expired-released")).toBeUndefined();
  });

  it("自定义 now 参数：未来时间点所有 active Hold 视为过期", async () => {
    const t = await ensureDefaultTenant();
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await createLegalHold(
      buildCreateParams({
        tenantId: t.id,
        targetId: "future-expire",
        validUntil,
      }),
    );

    const future = new Date(validUntil.getTime() + 24 * 60 * 60 * 1000);
    const expired = await listExpiredActiveHolds(future);
    expect(expired.find((h) => h.targetId === "future-expire")).toBeDefined();
  });
});
