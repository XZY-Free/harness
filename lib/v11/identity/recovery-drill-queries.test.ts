/**
 * S12-W08：V11 备份恢复演练集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createRecoveryDrill：创建（scheduled）+ 审计 recovery.drill + auditEventId 回填 + check 预填 +
 *   重复 active drill 检测 + environmentTag 校验 + 自定义/默认 RPO/RTO。
 * - getRecoveryDrillById：查询 + 跨租户隔离 + 不存在返回 null。
 * - listRecoveryDrills：cursor 分页 + drillType/state/executedBy 过滤。
 * - updateRecoveryDrillState：状态机合法/非法转移 + 审计 before/after + startedAt/completedAt 回填。
 * - startRecoveryDrill / completeRecoveryDrill / failRecoveryDrill / cancelRecoveryDrill：便捷封装。
 * - Check 管理：list / get / markCheckRunning（幂等）/ complete / fail / skip + 状态机非法转移。
 * - computeDrillSummary / deriveDrillTerminalState：汇总与终态派生。
 * - runConsistencyCheck：9 个 checkType 核对器（空数据 / 数据存在）。
 * - runAllChecksForDrill：批量执行 pending check + 自动 passed/failed。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/v11/identity/audit";
import { listAuditEvents } from "@/lib/v11/identity/audit-queries";
import {
  runAllChecksForDrill,
  runConsistencyCheck,
} from "@/lib/v11/identity/recovery-consistency-checker";
import {
  DRILL_RPO_RTO_DEFAULTS,
  cancelRecoveryDrill,
  completeRecoveryDrill,
  completeRecoveryDrillCheck,
  computeDrillSummary,
  createRecoveryDrill,
  deriveDrillTerminalState,
  failRecoveryDrill,
  failRecoveryDrillCheck,
  getRecoveryDrillById,
  getRecoveryDrillCheck,
  listRecoveryDrillChecks,
  listRecoveryDrills,
  markCheckRunning,
  skipRecoveryDrillCheck,
  startRecoveryDrill,
  updateRecoveryDrillState,
} from "@/lib/v11/identity/recovery-drill-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { v11DeletionRequest, v11DeletionStep } from "@/lib/v11/schema/deletion-request";
import { tenant } from "@/lib/v11/schema/identity";
import {
  DRILL_CHECK_MATRIX,
  type RecoveryCheckState,
  type RecoveryCheckType,
  type RecoveryDrillType,
  type V11RecoveryDrillCheck,
} from "@/lib/v11/schema/recovery-drill";
import { v11Artifact } from "@/lib/v11/schema/runtime-artifact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无全局 override 需清理
});

// ─── 辅助 ──────────────────────────────────────────────────

function buildActor(tenantId: string): AuditActor {
  return { tenantId, actorType: "user", actorId: "admin-001" };
}

function buildCreateParams(opts: {
  tenantId: string;
  drillType?: RecoveryDrillType;
  environmentTag?: string;
  executedBy?: string;
  rpoTargetSeconds?: number;
  rtoTargetSeconds?: number;
}) {
  return {
    tenantId: opts.tenantId,
    drillType: opts.drillType ?? ("db_restore" as const),
    environmentTag: opts.environmentTag ?? "isolated-staging-001",
    reason: "定期恢复演练",
    executedBy: opts.executedBy ?? "admin-001",
    executedByKind: "user" as const,
    rpoTargetSeconds: opts.rpoTargetSeconds,
    rtoTargetSeconds: opts.rtoTargetSeconds,
    actor: buildActor(opts.tenantId),
  };
}

async function seedExtraTenant(tenantId: string, key: string): Promise<void> {
  await db.insert(tenant).values({
    id: tenantId,
    key,
    name: `Extra Tenant ${key}`,
    status: "active",
  });
}

/** 取 checks 首个元素的 id（测试 fixture 约定至少插入一条）。 */
function firstCheckId(checks: V11RecoveryDrillCheck[]): string {
  const first = checks[0];
  if (!first) throw new Error("测试设置错误：期望至少一条 check");
  return first.id;
}

/** 将所有 check 标记为 passed（满足 completeRecoveryDrill 前置条件）。 */
async function passAllChecks(tenantId: string, drillId: string): Promise<void> {
  const checks = await listRecoveryDrillChecks(tenantId, drillId);
  for (const check of checks) {
    const running = await markCheckRunning({ tenantId, checkId: check.id });
    if (running.checkState !== "running") continue;
    await completeRecoveryDrillCheck({
      tenantId,
      checkId: check.id,
      evidenceRef: `evidence:${check.checkType}:${drillId}`,
      detailsJson: JSON.stringify({ verified: true }),
      durationMs: 10,
    });
  }
}

const EXTRA_TENANT_ID = "00000000-0000-4000-8000-0000000000a8";

// ═══════════════════════════════════════════════════════════
// 1. createRecoveryDrill
// ═══════════════════════════════════════════════════════════

describe("V11 createRecoveryDrill", () => {
  it("创建演练（scheduled 状态）并返回完整字段 + 默认 RPO/RTO", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    expect(drill.id).toBeDefined();
    expect(drill.tenantId).toBe(t.id);
    expect(drill.drillType).toBe("db_restore");
    expect(drill.drillState).toBe("scheduled");
    expect(drill.rpoTargetSeconds).toBe(DRILL_RPO_RTO_DEFAULTS.db_restore.rpoTargetSeconds);
    expect(drill.rtoTargetSeconds).toBe(DRILL_RPO_RTO_DEFAULTS.db_restore.rtoTargetSeconds);
    expect(drill.rpoActualSeconds).toBeNull();
    expect(drill.rtoActualSeconds).toBeNull();
    expect(drill.environmentTag).toBe("isolated-staging-001");
    expect(drill.reason).toBe("定期恢复演练");
    expect(drill.executedBy).toBe("admin-001");
    expect(drill.executedByKind).toBe("user");
    expect(drill.consistencySummaryJson).toBeNull();
    expect(drill.auditEventId).toBeTruthy();
    expect(drill.failureReason).toBeNull();
    expect(drill.scheduledAt).toBeInstanceOf(Date);
    expect(drill.startedAt).toBeNull();
    expect(drill.completedAt).toBeNull();
  });

  it("创建时写审计事件 recovery.drill 并回填 auditEventId", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "recovery.drill",
      targetType: "recovery_drill",
      targetId: drill.id,
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("user");
    expect(event?.actorId).toBe("admin-001");
    expect(event?.afterHash).toBeTruthy();
    expect(drill.auditEventId).toBe(event?.id);
  });

  it("按 drillType 预填 check 项（state=pending）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const expectedTypes = DRILL_CHECK_MATRIX.db_restore;
    expect(checks.length).toBe(expectedTypes.length);
    expect(checks.map((c) => c.checkType)).toEqual(expectedTypes);
    for (const c of checks) {
      expect(c.checkState).toBe("pending");
      expect(c.evidenceRef).toBeNull();
      expect(c.tenantId).toBe(t.id);
      expect(c.drillId).toBe(drill.id);
    }
  });

  it("各 drillType 预填的 check 数量符合 DRILL_CHECK_MATRIX", async () => {
    const t = await ensureDefaultTenant();
    const cases: Array<{ drillType: RecoveryDrillType; expected: readonly RecoveryCheckType[] }> = [
      { drillType: "db_restore", expected: DRILL_CHECK_MATRIX.db_restore },
      { drillType: "object_version", expected: DRILL_CHECK_MATRIX.object_version },
      { drillType: "secret_restore", expected: DRILL_CHECK_MATRIX.secret_restore },
      { drillType: "runtime_failover", expected: DRILL_CHECK_MATRIX.runtime_failover },
      { drillType: "queue_failover", expected: DRILL_CHECK_MATRIX.queue_failover },
    ];

    for (const c of cases) {
      const drill = await createRecoveryDrill(
        buildCreateParams({ tenantId: t.id, drillType: c.drillType }),
      );
      const checks = await listRecoveryDrillChecks(t.id, drill.id);
      expect(checks.length).toBe(c.expected.length);
      expect(checks.map((x) => x.checkType)).toEqual(c.expected);
    }
  });

  it("重复 active drill（同租户同 drillType）抛 duplicate_active_drill", async () => {
    const t = await ensureDefaultTenant();
    await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    await expect(createRecoveryDrill(buildCreateParams({ tenantId: t.id }))).rejects.toMatchObject({
      code: "duplicate_active_drill",
    });
  });

  it("不同 drillType 可并发存在（不触发 duplicate_active_drill）", async () => {
    const t = await ensureDefaultTenant();
    await createRecoveryDrill(buildCreateParams({ tenantId: t.id, drillType: "db_restore" }));
    const drill2 = await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "runtime_failover" }),
    );
    expect(drill2.drillType).toBe("runtime_failover");
  });

  it("终态后同 drillType 可再次创建", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await cancelRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
      reason: "环境异常",
    });

    const drill2 = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    expect(drill2.id).not.toBe(drill.id);
    expect(drill2.drillState).toBe("scheduled");
  });

  it("environmentTag 空字符串抛 invalid_environment", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      createRecoveryDrill(buildCreateParams({ tenantId: t.id, environmentTag: "" })),
    ).rejects.toMatchObject({ code: "invalid_environment" });
  });

  it("environmentTag 纯空白抛 invalid_environment", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      createRecoveryDrill(buildCreateParams({ tenantId: t.id, environmentTag: "   " })),
    ).rejects.toMatchObject({ code: "invalid_environment" });
  });

  it("自定义 RPO/RTO 覆盖默认值", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(
      buildCreateParams({
        tenantId: t.id,
        rpoTargetSeconds: 60,
        rtoTargetSeconds: 120,
      }),
    );
    expect(drill.rpoTargetSeconds).toBe(60);
    expect(drill.rtoTargetSeconds).toBe(120);
  });

  it("service 执行人类型正确记录", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill({
      tenantId: t.id,
      drillType: "db_restore",
      environmentTag: "isolated-staging-001",
      reason: "自动演练",
      executedBy: "scheduler-svc",
      executedByKind: "service",
      actor: buildActor(t.id),
    });
    expect(drill.executedByKind).toBe("service");
    expect(drill.executedBy).toBe("scheduler-svc");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. getRecoveryDrillById
// ═══════════════════════════════════════════════════════════

describe("V11 getRecoveryDrillById", () => {
  it("按 id 查询演练", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const found = await getRecoveryDrillById(t.id, drill.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(drill.id);
  });

  it("不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getRecoveryDrillById(t.id, "non-existent");
    expect(found).toBeNull();
  });

  it("跨租户隔离：getRecoveryDrillById", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const found = await getRecoveryDrillById(EXTRA_TENANT_ID, drill.id);
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. listRecoveryDrills（cursor 分页 + 过滤）
// ═══════════════════════════════════════════════════════════

describe("V11 listRecoveryDrills", () => {
  it("按 scheduledAt 升序返回", async () => {
    const t = await ensureDefaultTenant();
    // 用不同 drillType 避免触发 duplicate_active_drill
    const types: RecoveryDrillType[] = ["db_restore", "runtime_failover", "queue_failover"];
    for (const dt of types) {
      await createRecoveryDrill(buildCreateParams({ tenantId: t.id, drillType: dt }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page = await listRecoveryDrills({ tenantId: t.id });
    expect(page.items.length).toBe(3);
    expect(page.items[0]?.drillType).toBe("db_restore");
    expect(page.items[2]?.drillType).toBe("queue_failover");
    expect(page.nextCursor).toBeNull();
  });

  it("limit 截断 + nextCursor 翻页", async () => {
    const t = await ensureDefaultTenant();
    const types: RecoveryDrillType[] = [
      "db_restore",
      "runtime_failover",
      "queue_failover",
      "object_version",
      "secret_restore",
    ];
    for (const dt of types) {
      await createRecoveryDrill(buildCreateParams({ tenantId: t.id, drillType: dt }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listRecoveryDrills({ tenantId: t.id, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listRecoveryDrills({
      tenantId: t.id,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listRecoveryDrills({
      tenantId: t.id,
      limit: 2,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.items.length).toBe(1);
    expect(page3.nextCursor).toBeNull();

    // 汇总所有 id 唯一
    const allIds = [...page1.items, ...page2.items, ...page3.items].map((d) => d.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("按 drillType 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createRecoveryDrill(buildCreateParams({ tenantId: t.id, drillType: "db_restore" }));
    await createRecoveryDrill(buildCreateParams({ tenantId: t.id, drillType: "runtime_failover" }));

    const page = await listRecoveryDrills({ tenantId: t.id, drillType: "db_restore" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.drillType).toBe("db_restore");
  });

  it("按 drillState 过滤", async () => {
    const t = await ensureDefaultTenant();
    const d1 = await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "db_restore" }),
    );
    await createRecoveryDrill(buildCreateParams({ tenantId: t.id, drillType: "runtime_failover" }));
    await cancelRecoveryDrill({
      tenantId: t.id,
      id: d1.id,
      actor: buildActor(t.id),
      reason: "中止",
    });

    const scheduledPage = await listRecoveryDrills({ tenantId: t.id, drillState: "scheduled" });
    expect(scheduledPage.items.length).toBe(1);
    expect(scheduledPage.items[0]?.drillType).toBe("runtime_failover");

    const cancelledPage = await listRecoveryDrills({ tenantId: t.id, drillState: "cancelled" });
    expect(cancelledPage.items.length).toBe(1);
    expect(cancelledPage.items[0]?.id).toBe(d1.id);
  });

  it("按 executedBy 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "db_restore", executedBy: "admin-001" }),
    );
    await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "runtime_failover", executedBy: "admin-002" }),
    );

    const page = await listRecoveryDrills({ tenantId: t.id, executedBy: "admin-001" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.executedBy).toBe("admin-001");
  });

  it("跨租户隔离：listRecoveryDrills", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const otherPage = await listRecoveryDrills({ tenantId: EXTRA_TENANT_ID });
    expect(otherPage.items.length).toBe(0);
  });

  it("非法 cursor 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      listRecoveryDrills({ tenantId: t.id, cursor: "!!!invalid-base64!!!" }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });
});

// ═══════════════════════════════════════════════════════════
// 4. updateRecoveryDrillState（状态机）
// ═══════════════════════════════════════════════════════════

describe("V11 updateRecoveryDrillState", () => {
  it("合法转移：scheduled → running → completed", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const running = await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "running",
      actor: buildActor(t.id),
    });
    expect(running.drillState).toBe("running");
    expect(running.startedAt).toBeInstanceOf(Date);
    expect(running.completedAt).toBeNull();

    await passAllChecks(t.id, drill.id);

    const completed = await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "completed",
      actor: buildActor(t.id),
    });
    expect(completed.drillState).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it("合法转移：scheduled → cancelled", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const cancelled = await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "cancelled",
      actor: buildActor(t.id),
    });
    expect(cancelled.drillState).toBe("cancelled");
    expect(cancelled.completedAt).toBeInstanceOf(Date);
  });

  it("合法转移：running → failed（含 failureReason）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "running",
      actor: buildActor(t.id),
    });

    const failed = await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "failed",
      actor: buildActor(t.id),
      failureReason: "Event sequence 出现间隙",
    });
    expect(failed.drillState).toBe("failed");
    expect(failed.failureReason).toBe("Event sequence 出现间隙");
    expect(failed.completedAt).toBeInstanceOf(Date);
  });

  it("合法转移：running → cancelled", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "running",
      actor: buildActor(t.id),
    });

    const cancelled = await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "cancelled",
      actor: buildActor(t.id),
    });
    expect(cancelled.drillState).toBe("cancelled");
  });

  it("非法转移：scheduled → completed（跳过 running）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    await expect(
      updateRecoveryDrillState({
        tenantId: t.id,
        id: drill.id,
        nextState: "completed",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("非法转移：scheduled → failed（跳过 running）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    await expect(
      updateRecoveryDrillState({
        tenantId: t.id,
        id: drill.id,
        nextState: "failed",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("非法转移：completed → running（终态不可推进）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "running",
      actor: buildActor(t.id),
    });
    await passAllChecks(t.id, drill.id);
    await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "completed",
      actor: buildActor(t.id),
    });

    await expect(
      updateRecoveryDrillState({
        tenantId: t.id,
        id: drill.id,
        nextState: "running",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("演练不存在抛 drill_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      updateRecoveryDrillState({
        tenantId: t.id,
        id: "non-existent",
        nextState: "running",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "drill_not_found" });
  });

  it("状态转移写审计 before/after", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "running",
      actor: buildActor(t.id),
    });

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "recovery.drill",
      targetType: "recovery_drill",
      targetId: drill.id,
    });
    // 创建 + 状态转移 = 2 条
    expect(events.length).toBe(2);
    const transitionEvent = events[1];
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent?.beforeHash).toBeTruthy();
    expect(transitionEvent?.afterHash).toBeTruthy();
  });

  it("rpoActualSeconds / rtoActualSeconds 在状态转移时记录", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "running",
      actor: buildActor(t.id),
    });
    await passAllChecks(t.id, drill.id);

    const completed = await updateRecoveryDrillState({
      tenantId: t.id,
      id: drill.id,
      nextState: "completed",
      actor: buildActor(t.id),
      rpoActualSeconds: 42,
      rtoActualSeconds: 360,
    });
    expect(completed.rpoActualSeconds).toBe(42);
    expect(completed.rtoActualSeconds).toBe(360);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 便捷封装：start / complete / fail / cancel
// ═══════════════════════════════════════════════════════════

describe("V11 startRecoveryDrill / completeRecoveryDrill / failRecoveryDrill / cancelRecoveryDrill", () => {
  it("startRecoveryDrill：scheduled → running", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const running = await startRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
    });
    expect(running.drillState).toBe("running");
    expect(running.startedAt).toBeInstanceOf(Date);
  });

  it("completeRecoveryDrill：所有 check passed 后可完成 + 回填 consistencySummaryJson", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });
    await passAllChecks(t.id, drill.id);

    const completed = await completeRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
      rpoActualSeconds: 100,
      rtoActualSeconds: 500,
    });
    expect(completed.drillState).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.rpoActualSeconds).toBe(100);
    expect(completed.rtoActualSeconds).toBe(500);

    const summary = JSON.parse(completed.consistencySummaryJson ?? "{}");
    expect(summary.checkCount).toBe(DRILL_CHECK_MATRIX.db_restore.length);
    expect(summary.passedCount).toBe(DRILL_CHECK_MATRIX.db_restore.length);
    expect(summary.failedCount).toBe(0);
  });

  it("completeRecoveryDrill：存在未完成 check 时抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });
    // 未处理 check 直接 complete

    await expect(
      completeRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("completeRecoveryDrill：含 failed check 时抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "object_version" }),
    );
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });

    // 让一个 check failed
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });
    await failRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      evidenceRef: "evidence:fail",
      failureReason: "Artifact 引用缺失",
    });

    await expect(
      completeRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("completeRecoveryDrill：含 skipped check 视为完成", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "object_version" }),
    );
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });

    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    // skip 一个，pass 另一个
    const skipped = checks[0];
    const passed = checks[1];
    if (!skipped || !passed) throw new Error("测试设置错误：期望至少 2 条 check");
    await skipRecoveryDrillCheck({
      tenantId: t.id,
      checkId: skipped.id,
      reason: "本环境不适用",
    });
    await markCheckRunning({ tenantId: t.id, checkId: passed.id });
    await completeRecoveryDrillCheck({
      tenantId: t.id,
      checkId: passed.id,
      evidenceRef: "evidence:ok",
      detailsJson: JSON.stringify({ verified: true }),
      durationMs: 5,
    });

    const completed = await completeRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
    });
    expect(completed.drillState).toBe("completed");
    const summary = JSON.parse(completed.consistencySummaryJson ?? "{}");
    expect(summary.passedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
  });

  it("failRecoveryDrill：running → failed + 回填 failureReason + consistencySummaryJson", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(
      buildCreateParams({ tenantId: t.id, drillType: "object_version" }),
    );
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });

    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });
    await failRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      evidenceRef: "evidence:fail",
      failureReason: "核对失败",
    });

    const failed = await failRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
      failureReason: "演练未通过一致性核对",
    });
    expect(failed.drillState).toBe("failed");
    expect(failed.failureReason).toBe("演练未通过一致性核对");
    const summary = JSON.parse(failed.consistencySummaryJson ?? "{}");
    expect(summary.failedCount).toBe(1);
  });

  it("cancelRecoveryDrill：scheduled → cancelled", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const cancelled = await cancelRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
      reason: "环境异常中止",
    });
    expect(cancelled.drillState).toBe("cancelled");
  });

  it("cancelRecoveryDrill：running → cancelled", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });

    const cancelled = await cancelRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
      reason: "运行中中止",
    });
    expect(cancelled.drillState).toBe("cancelled");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Check 管理
// ═══════════════════════════════════════════════════════════

describe("V11 Check 管理", () => {
  it("listRecoveryDrillChecks 按 checkType 升序返回（MySQL enum 定义序）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));

    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    // MySQL enum 按 RECOVERY_CHECK_TYPES 定义顺序排序（非字母序）
    const expectedOrder = DRILL_CHECK_MATRIX.db_restore;
    expect(checks.map((c) => c.checkType)).toEqual(expectedOrder);
  });

  it("getRecoveryDrillCheck 按 id 查询 + 跨租户隔离", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);

    const found = await getRecoveryDrillCheck(t.id, firstId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(firstId);

    const other = await getRecoveryDrillCheck(EXTRA_TENANT_ID, firstId);
    expect(other).toBeNull();
  });

  it("getRecoveryDrillCheck 不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getRecoveryDrillCheck(t.id, "non-existent");
    expect(found).toBeNull();
  });

  it("markCheckRunning：pending → running（幂等：已终态原样返回）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);

    const running = await markCheckRunning({ tenantId: t.id, checkId: firstId });
    expect(running.checkState).toBe("running");

    // 再次调用：幂等返回（非 pending 不重复执行）
    const again = await markCheckRunning({ tenantId: t.id, checkId: firstId });
    expect(again.checkState).toBe("running");
    expect(again.id).toBe(running.id);
  });

  it("markCheckRunning：check 不存在抛 check_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      markCheckRunning({ tenantId: t.id, checkId: "non-existent" }),
    ).rejects.toMatchObject({ code: "check_not_found" });
  });

  it("completeRecoveryDrillCheck：running → passed + 写 evidenceRef/detailsJson/durationMs", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });

    const passed = await completeRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      evidenceRef: "s3://bucket/evidence/report-001.json",
      detailsJson: JSON.stringify({ gapCount: 0 }),
      durationMs: 42,
    });
    expect(passed.checkState).toBe("passed");
    expect(passed.evidenceRef).toBe("s3://bucket/evidence/report-001.json");
    expect(passed.detailsJson).toBe(JSON.stringify({ gapCount: 0 }));
    expect(passed.durationMs).toBe(42);
    expect(passed.completedAt).toBeInstanceOf(Date);
  });

  it("completeRecoveryDrillCheck：evidenceRef 空抛 missing_evidence", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });

    await expect(
      completeRecoveryDrillCheck({
        tenantId: t.id,
        checkId: firstId,
        evidenceRef: "",
      }),
    ).rejects.toMatchObject({ code: "missing_evidence" });
  });

  it("completeRecoveryDrillCheck：pending 状态直接 complete 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);

    await expect(
      completeRecoveryDrillCheck({
        tenantId: t.id,
        checkId: firstId,
        evidenceRef: "evidence:ok",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("completeRecoveryDrillCheck：passed 状态再次 complete 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });
    await completeRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      evidenceRef: "evidence:ok",
    });

    await expect(
      completeRecoveryDrillCheck({
        tenantId: t.id,
        checkId: firstId,
        evidenceRef: "evidence:ok2",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("failRecoveryDrillCheck：running → failed + 写 evidenceRef/failureReason", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });

    const failed = await failRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      evidenceRef: "s3://bucket/evidence/fail-001.json",
      failureReason: "Event sequence 存在间隙",
      detailsJson: JSON.stringify({ gapCount: 3 }),
      durationMs: 15,
    });
    expect(failed.checkState).toBe("failed");
    expect(failed.evidenceRef).toBe("s3://bucket/evidence/fail-001.json");
    expect(failed.failureReason).toBe("Event sequence 存在间隙");
    expect(failed.completedAt).toBeInstanceOf(Date);
  });

  it("failRecoveryDrillCheck：evidenceRef 空抛 missing_evidence", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });

    await expect(
      failRecoveryDrillCheck({
        tenantId: t.id,
        checkId: firstId,
        evidenceRef: "   ",
        failureReason: "失败",
      }),
    ).rejects.toMatchObject({ code: "missing_evidence" });
  });

  it("skipRecoveryDrillCheck：pending → skipped", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);

    const skipped = await skipRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      reason: "本环境不适用",
    });
    expect(skipped.checkState).toBe("skipped");
    expect(skipped.failureReason).toBe("本环境不适用");
    expect(skipped.completedAt).toBeInstanceOf(Date);
  });

  it("skipRecoveryDrillCheck：running 状态抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    await markCheckRunning({ tenantId: t.id, checkId: firstId });

    await expect(
      skipRecoveryDrillCheck({
        tenantId: t.id,
        checkId: firstId,
        reason: "跳过",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });
});

// ═══════════════════════════════════════════════════════════
// 7. computeDrillSummary / deriveDrillTerminalState
// ═══════════════════════════════════════════════════════════

describe("V11 computeDrillSummary / deriveDrillTerminalState", () => {
  function makeCheck(state: RecoveryCheckState): V11RecoveryDrillCheck {
    return {
      id: `check-${state}-${Math.random()}`,
      tenantId: "t",
      drillId: "d",
      checkType: "event_sequence",
      checkState: state,
      evidenceRef: null,
      detailsJson: null,
      failureReason: null,
      durationMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };
  }

  it("computeDrillSummary：空列表返回全 0", () => {
    const summary = computeDrillSummary([]);
    expect(summary.checkCount).toBe(0);
    expect(summary.passedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.pendingCount).toBe(0);
    expect(summary.runningCount).toBe(0);
  });

  it("computeDrillSummary：各状态正确计数", () => {
    const checks = [
      makeCheck("passed"),
      makeCheck("passed"),
      makeCheck("failed"),
      makeCheck("skipped"),
      makeCheck("pending"),
      makeCheck("running"),
    ];
    const summary = computeDrillSummary(checks);
    expect(summary.checkCount).toBe(6);
    expect(summary.passedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(summary.pendingCount).toBe(1);
    expect(summary.runningCount).toBe(1);
  });

  it("deriveDrillTerminalState：空列表返回 completed", () => {
    expect(deriveDrillTerminalState([])).toBe("completed");
  });

  it("deriveDrillTerminalState：全 passed 返回 completed", () => {
    const checks = [makeCheck("passed"), makeCheck("passed")];
    expect(deriveDrillTerminalState(checks)).toBe("completed");
  });

  it("deriveDrillTerminalState：全 passed/skipped 返回 completed", () => {
    const checks = [makeCheck("passed"), makeCheck("skipped")];
    expect(deriveDrillTerminalState(checks)).toBe("completed");
  });

  it("deriveDrillTerminalState：含 pending 返回 null（不自动终态）", () => {
    const checks = [makeCheck("passed"), makeCheck("pending")];
    expect(deriveDrillTerminalState(checks)).toBeNull();
  });

  it("deriveDrillTerminalState：含 running 返回 null", () => {
    const checks = [makeCheck("passed"), makeCheck("running")];
    expect(deriveDrillTerminalState(checks)).toBeNull();
  });

  it("deriveDrillTerminalState：含 failed 且无 pending/running 返回 failed", () => {
    const checks = [makeCheck("passed"), makeCheck("failed"), makeCheck("skipped")];
    expect(deriveDrillTerminalState(checks)).toBe("failed");
  });

  it("deriveDrillTerminalState：含 failed 但仍有 pending 返回 null", () => {
    const checks = [makeCheck("failed"), makeCheck("pending")];
    expect(deriveDrillTerminalState(checks)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 8. runConsistencyCheck（核对器）
// ═══════════════════════════════════════════════════════════

describe("V11 runConsistencyCheck", () => {
  it("event_sequence：空数据返回 passed + evidenceRef", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "event_sequence");
    expect(result.passed).toBe(true);
    expect(result.evidenceRef).toContain("event_sequence:");
    expect(result.details.turnCount).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("projection_checkpoint：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "projection_checkpoint");
    expect(result.passed).toBe(true);
    expect(result.evidenceRef).toContain("projection_checkpoint:");
    expect(result.details.itemCount).toBe(0);
  });

  it("artifact_ref：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "artifact_ref");
    expect(result.passed).toBe(true);
    expect(result.details.artifactCount).toBe(0);
  });

  it("artifact_ref：含非法 contentRef 返回 failed", async () => {
    const t = await ensureDefaultTenant();
    await db.insert(v11Artifact).values({
      id: "art-bad-001",
      tenantId: t.id,
      invocationId: "inv-001",
      artifactType: "report",
      displayName: "bad-report.json",
      contentRef: "http://unmanaged.example.com/file",
      mediaType: "application/json",
      byteSize: 1024,
      contentHash: "sha256:abc",
      visibilityScope: "owner",
    });

    const result = await runConsistencyCheck(t.id, "artifact_ref");
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("非法或缺失");
    expect(result.details.invalidCount).toBe(1);
  });

  it("artifact_ref：受管前缀（s3://）返回 passed", async () => {
    const t = await ensureDefaultTenant();
    await db.insert(v11Artifact).values({
      id: "art-ok-001",
      tenantId: t.id,
      invocationId: "inv-002",
      artifactType: "report",
      displayName: "ok-report.json",
      contentRef: "s3://bucket/path/file.json",
      mediaType: "application/json",
      byteSize: 1024,
      contentHash: "sha256:abc",
      visibilityScope: "owner",
    });

    const result = await runConsistencyCheck(t.id, "artifact_ref");
    expect(result.passed).toBe(true);
    expect(result.details.invalidCount).toBe(0);
  });

  it("legal_hold：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "legal_hold");
    expect(result.passed).toBe(true);
    expect(result.details.activeHoldCount).toBe(0);
  });

  it("deletion_evidence：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "deletion_evidence");
    expect(result.passed).toBe(true);
    expect(result.details.completedStepCount).toBe(0);
  });

  it("deletion_evidence：completed step 缺 evidenceRef 返回 failed", async () => {
    const t = await ensureDefaultTenant();
    // 直接插入 deletion request + step（绕过 queries，专注于核对器逻辑）
    await db.insert(v11DeletionRequest).values({
      id: "del-req-001",
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-001",
      deleteMode: "standard",
      reasonCode: "ADMIN_POLICY",
      requestedBy: "admin-001",
      requestPrincipalKind: "user",
      requestState: "completed",
    });
    await db.insert(v11DeletionStep).values({
      id: "del-step-001",
      tenantId: t.id,
      requestId: "del-req-001",
      storeType: "mysql",
      subjectRef: "thread:thr-001",
      stepState: "completed",
      evidenceRef: null,
    });

    const result = await runConsistencyCheck(t.id, "deletion_evidence");
    expect(result.passed).toBe(false);
    expect(result.details.missingEvidenceCount).toBe(1);
  });

  it("deletion_evidence：completed step 含 evidenceRef 返回 passed", async () => {
    const t = await ensureDefaultTenant();
    await db.insert(v11DeletionRequest).values({
      id: "del-req-002",
      tenantId: t.id,
      subjectType: "thread",
      subjectId: "thr-002",
      deleteMode: "standard",
      reasonCode: "ADMIN_POLICY",
      requestedBy: "admin-001",
      requestPrincipalKind: "user",
      requestState: "completed",
    });
    await db.insert(v11DeletionStep).values({
      id: "del-step-002",
      tenantId: t.id,
      requestId: "del-req-002",
      storeType: "mysql",
      subjectRef: "thread:thr-002",
      stepState: "completed",
      evidenceRef: "mysql:binlog:001",
    });

    const result = await runConsistencyCheck(t.id, "deletion_evidence");
    expect(result.passed).toBe(true);
    expect(result.details.completedStepCount).toBe(1);
  });

  it("tool_call_pending：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "tool_call_pending");
    expect(result.passed).toBe(true);
    expect(result.details.pendingCount).toBe(0);
  });

  it("unknown_effect：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "unknown_effect");
    expect(result.passed).toBe(true);
    expect(result.details.unknownEffectCount).toBe(0);
  });

  it("job_recovery：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "job_recovery");
    expect(result.passed).toBe(true);
    expect(result.details.activeJobCount).toBe(0);
  });

  it("user_action_wait：空数据返回 passed", async () => {
    const t = await ensureDefaultTenant();
    const result = await runConsistencyCheck(t.id, "user_action_wait");
    expect(result.passed).toBe(true);
    expect(result.details.pendingRequestCount).toBe(0);
  });

  it("核对器跨租户隔离：只核对当前租户数据", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    // 在 EXTRA_TENANT 插入非法 artifact
    await db.insert(v11Artifact).values({
      id: "art-other-001",
      tenantId: EXTRA_TENANT_ID,
      invocationId: "inv-other-001",
      artifactType: "report",
      displayName: "other-report.json",
      contentRef: "http://unmanaged.example.com/other",
      mediaType: "application/json",
      byteSize: 1024,
      contentHash: "sha256:abc",
      visibilityScope: "owner",
    });

    // 默认租户核对应 passed（看不到 other tenant 的非法 artifact）
    const result = await runConsistencyCheck(t.id, "artifact_ref");
    expect(result.passed).toBe(true);
    expect(result.details.artifactCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. runAllChecksForDrill（批量执行）
// ═══════════════════════════════════════════════════════════

describe("V11 runAllChecksForDrill", () => {
  it("批量执行所有 pending check（空数据全部 passed）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const initialChecks = await listRecoveryDrillChecks(t.id, drill.id);

    const updated = await runAllChecksForDrill({
      tenantId: t.id,
      drillId: drill.id,
      checks: initialChecks,
    });

    expect(updated.length).toBe(initialChecks.length);
    for (const c of updated) {
      expect(c.checkState).toBe("passed");
      expect(c.evidenceRef).toBeTruthy();
      expect(c.completedAt).toBeInstanceOf(Date);
    }
  });

  it("已终态的 check 不重复执行（原样返回）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    const checks = await listRecoveryDrillChecks(t.id, drill.id);
    const firstId = firstCheckId(checks);
    // 手动完成一个
    await markCheckRunning({ tenantId: t.id, checkId: firstId });
    await completeRecoveryDrillCheck({
      tenantId: t.id,
      checkId: firstId,
      evidenceRef: "manual:evidence",
      durationMs: 1,
    });
    const updatedBeforeRun = await listRecoveryDrillChecks(t.id, drill.id);

    const updated = await runAllChecksForDrill({
      tenantId: t.id,
      drillId: drill.id,
      checks: updatedBeforeRun,
    });

    // 已 passed 的保持原 evidenceRef
    const passedCheck = updated.find((c) => c.id === firstId);
    expect(passedCheck?.checkState).toBe("passed");
    expect(passedCheck?.evidenceRef).toBe("manual:evidence");
    // 其余 pending 的也被核对完成
    for (const c of updated) {
      expect(["passed", "failed", "skipped"]).toContain(c.checkState);
    }
  });

  it("批量执行后可 completeRecoveryDrill（drillState=completed）", async () => {
    const t = await ensureDefaultTenant();
    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });
    const checks = await listRecoveryDrillChecks(t.id, drill.id);

    await runAllChecksForDrill({
      tenantId: t.id,
      drillId: drill.id,
      checks,
    });

    const completed = await completeRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
    });
    expect(completed.drillState).toBe("completed");
  });

  it("含非法 artifact 时 db_restore 演练批量核对后 completeRecoveryDrill 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    // 注入非法 artifact（artifact_ref check 会 failed）
    await db.insert(v11Artifact).values({
      id: "art-bad-drill-001",
      tenantId: t.id,
      invocationId: "inv-bad-drill-001",
      artifactType: "report",
      displayName: "bad-report.json",
      contentRef: "http://unmanaged.example.com/bad",
      mediaType: "application/json",
      byteSize: 1024,
      contentHash: "sha256:abc",
      visibilityScope: "owner",
    });

    const drill = await createRecoveryDrill(buildCreateParams({ tenantId: t.id }));
    await startRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) });
    const checks = await listRecoveryDrillChecks(t.id, drill.id);

    const updated = await runAllChecksForDrill({
      tenantId: t.id,
      drillId: drill.id,
      checks,
    });

    // artifact_ref 应 failed
    const artifactCheck = updated.find((c) => c.checkType === "artifact_ref");
    expect(artifactCheck?.checkState).toBe("failed");
    expect(artifactCheck?.evidenceRef).toBeTruthy();
    expect(artifactCheck?.failureReason).toContain("非法或缺失");

    // completeRecoveryDrill 应被阻止
    await expect(
      completeRecoveryDrill({ tenantId: t.id, id: drill.id, actor: buildActor(t.id) }),
    ).rejects.toMatchObject({ code: "illegal_transition" });

    // failRecoveryDrill 可成功
    const failed = await failRecoveryDrill({
      tenantId: t.id,
      id: drill.id,
      actor: buildActor(t.id),
      failureReason: "artifact_ref 核对失败",
    });
    expect(failed.drillState).toBe("failed");
  });
});
