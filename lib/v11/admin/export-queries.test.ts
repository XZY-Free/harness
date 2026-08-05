/**
 * S11-W08：V11 AdminExport 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createAdminExport：默认值 + 全字段透传 + 审计 admin.export.requested
 * - getAdminExportById：命中 + 不存在 + 跨租户隔离
 * - listAdminExportsByTenant：created_at 降序 + status/exportKind/requestedBy 过滤 + cursor 分页 + 跨租户隔离
 * - updateAdminExportStatus：running/completed/failed/cancelled 状态转换 + failed 审计 + failureReason
 * - updateAdminExportResult：resultRef + recordCount + redactionSummary + completedAt + 审计 admin.export.completed
 *
 * 不变量（事实源：11 文档 S11-W08 行 96-101）：
 * - 管理写操作使用幂等键、If-Match/版本或等价并发保护（POST 路由层覆盖）。
 * - 列表、筛选、分页和导出遵守租户/组织/Action Scope（路由层覆盖）。
 * - 导出同样脱敏并审计（runner + download 路由覆盖）。
 * - 跨租户隔离：所有查询按 tenantId 过滤
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  createAdminExport,
  getAdminExportById,
  listAdminExportsByTenant,
  updateAdminExportResult,
  updateAdminExportStatus,
} from "@/lib/v11/admin/export-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 默认 actor ─────────────────────────

async function seedTenant() {
  const tenant = await ensureDefaultTenant();
  return { tenantId: tenant.id };
}

function buildActor(tenantId: string): AuditActor {
  return {
    tenantId,
    actorType: "user",
    actorId: "uid-test-001",
  };
}

/** 创建一个默认 AdminExport（audit_events 类型）。 */
async function createDefaultExport(
  tenantId: string,
  options?: {
    exportKind?:
      | "audit_events"
      | "usage_records"
      | "cost_aggregates"
      | "capacity_snapshots"
      | "traces"
      | "evaluation_runs";
    requestedBy?: string;
    requestPrincipalKind?: "user" | "service";
    filterJson?: Record<string, unknown> | null;
    resultFormat?: "ndjson" | "csv";
    /** 显式 created_at（cursor 分页测试用，确保顺序确定性）。 */
    createdAt?: Date;
  },
) {
  return createAdminExport({
    tenantId,
    requestedBy: options?.requestedBy ?? "uid-test-001",
    requestPrincipalKind: options?.requestPrincipalKind ?? "user",
    exportKind: options?.exportKind ?? "audit_events",
    filterJson: options?.filterJson ?? null,
    resultFormat: options?.resultFormat ?? "ndjson",
    actor: buildActor(tenantId),
    requestId: "req-test-001",
    ...(options?.createdAt ? { createdAt: options.createdAt } : {}),
  });
}

// ─── createAdminExport ─────────────────────────────────

describe("createAdminExport", () => {
  it("默认值（status=pending + versionNo=1 + recordCount=0）", async () => {
    const fx = await seedTenant();

    const record = await createDefaultExport(fx.tenantId);

    expect(record.tenantId).toBe(fx.tenantId);
    expect(record.requestedBy).toBe("uid-test-001");
    expect(record.requestPrincipalKind).toBe("user");
    expect(record.exportKind).toBe("audit_events");
    expect(record.filterJson).toBeNull();
    expect(record.status).toBe("pending");
    expect(record.resultRef).toBeNull();
    expect(record.resultFormat).toBe("ndjson");
    expect(record.recordCount).toBe(0);
    expect(record.redactionSummary).toBeNull();
    expect(record.failureReason).toBeNull();
    expect(record.versionNo).toBe("1");
    expect(record.completedAt).toBeNull();
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.updatedAt).toBeInstanceOf(Date);
  });

  it("全字段透传", async () => {
    const fx = await seedTenant();
    const filterJson = { dimension: "token_input", scope_type: "tenant" };

    const record = await createDefaultExport(fx.tenantId, {
      exportKind: "usage_records",
      requestedBy: "service-cicd",
      requestPrincipalKind: "service",
      filterJson,
      resultFormat: "csv",
    });

    expect(record.exportKind).toBe("usage_records");
    expect(record.requestedBy).toBe("service-cicd");
    expect(record.requestPrincipalKind).toBe("service");
    expect(record.filterJson).toEqual(filterJson);
    expect(record.resultFormat).toBe("csv");
  });

  it("写审计事件 admin.export.requested", async () => {
    const fx = await seedTenant();

    await createDefaultExport(fx.tenantId);

    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.requested",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe("user");
    expect(events[0]?.actorId).toBe("uid-test-001");
    expect(events[0]?.targetType).toBe("tenant");
    expect(events[0]?.targetId).toBe(fx.tenantId);
    expect(events[0]?.requestId).toBe("req-test-001");
  });
});

// ─── getAdminExportById ────────────────────────────────

describe("getAdminExportById", () => {
  it("命中同租户记录", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    const found = await getAdminExportById(fx.tenantId, record.id);
    expect(found?.id).toBe(record.id);
    expect(found?.exportKind).toBe("audit_events");
  });

  it("不存在返回 null", async () => {
    const fx = await seedTenant();
    const found = await getAdminExportById(fx.tenantId, randomUUID());
    expect(found).toBeNull();
  });

  it("跨租户查询返回 null", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    const crossTenant = await getAdminExportById(randomUUID(), record.id);
    expect(crossTenant).toBeNull();
  });
});

// ─── listAdminExportsByTenant ─────────────────────────

describe("listAdminExportsByTenant", () => {
  it("按 created_at 降序返回", async () => {
    const fx = await seedTenant();
    const r1 = await createDefaultExport(fx.tenantId, {
      createdAt: new Date(2026, 6, 22, 10, 0, 0),
    });
    const r2 = await createDefaultExport(fx.tenantId, {
      createdAt: new Date(2026, 6, 22, 10, 0, 1),
    });

    const result = await listAdminExportsByTenant(fx.tenantId);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).toBe(r2.id); // 最新的在前
    expect(result.items[1]?.id).toBe(r1.id);
    expect(result.nextCursor).toBeNull();
  });

  it("status 过滤", async () => {
    const fx = await seedTenant();
    const r1 = await createDefaultExport(fx.tenantId, {
      createdAt: new Date(2026, 6, 22, 10, 0, 0),
    });
    const r2 = await createDefaultExport(fx.tenantId, {
      createdAt: new Date(2026, 6, 22, 10, 0, 1),
    });

    // 把 r1 标为 running
    await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: r1.id,
      status: "running",
      actor: buildActor(fx.tenantId),
    });

    const runningOnly = await listAdminExportsByTenant(fx.tenantId, { status: "running" });
    expect(runningOnly.items).toHaveLength(1);
    expect(runningOnly.items[0]?.id).toBe(r1.id);
    expect(runningOnly.items[0]?.status).toBe("running");

    const pendingOnly = await listAdminExportsByTenant(fx.tenantId, { status: "pending" });
    expect(pendingOnly.items).toHaveLength(1);
    expect(pendingOnly.items[0]?.id).toBe(r2.id);
  });

  it("exportKind 过滤", async () => {
    const fx = await seedTenant();
    await createDefaultExport(fx.tenantId, { exportKind: "audit_events" });
    await createDefaultExport(fx.tenantId, { exportKind: "usage_records" });
    await createDefaultExport(fx.tenantId, { exportKind: "audit_events" });

    const auditOnly = await listAdminExportsByTenant(fx.tenantId, {
      exportKind: "audit_events",
    });
    expect(auditOnly.items).toHaveLength(2);
    expect(auditOnly.items.every((r) => r.exportKind === "audit_events")).toBe(true);

    const usageOnly = await listAdminExportsByTenant(fx.tenantId, {
      exportKind: "usage_records",
    });
    expect(usageOnly.items).toHaveLength(1);
  });

  it("requestedBy 过滤", async () => {
    const fx = await seedTenant();
    await createDefaultExport(fx.tenantId, { requestedBy: "uid-A" });
    await createDefaultExport(fx.tenantId, { requestedBy: "uid-B" });
    await createDefaultExport(fx.tenantId, { requestedBy: "uid-A" });

    const aOnly = await listAdminExportsByTenant(fx.tenantId, { requestedBy: "uid-A" });
    expect(aOnly.items).toHaveLength(2);
    expect(aOnly.items.every((r) => r.requestedBy === "uid-A")).toBe(true);
  });

  it("cursor 分页：limit+1 策略 + nextCursor 续读", async () => {
    const fx = await seedTenant();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      // 显式 createdAt（每秒递增）确保 cursor 分页顺序确定性，不依赖 CURRENT_TIMESTAMP(3) 精度
      const r = await createDefaultExport(fx.tenantId, {
        createdAt: new Date(2026, 6, 22, 10, 0, i),
      });
      created.push(r.id);
    }
    // created 数组按时间升序，列表按 created_at desc 返回，所以反转
    const expectedDesc = [...created].reverse();

    const page1 = await listAdminExportsByTenant(fx.tenantId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.id).toBe(expectedDesc[0]);
    expect(page1.items[1]?.id).toBe(expectedDesc[1]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listAdminExportsByTenant(fx.tenantId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]?.id).toBe(expectedDesc[2]);
    expect(page2.items[1]?.id).toBe(expectedDesc[3]);

    const page3 = await listAdminExportsByTenant(fx.tenantId, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.id).toBe(expectedDesc[4]);
    expect(page3.nextCursor).toBeNull();
  });

  it("跨租户查询返回空数组", async () => {
    const fx = await seedTenant();
    await createDefaultExport(fx.tenantId);

    const otherTenant = await listAdminExportsByTenant(randomUUID());
    expect(otherTenant.items).toHaveLength(0);
    expect(otherTenant.nextCursor).toBeNull();
  });

  it("非法 cursor 抛错", async () => {
    const fx = await seedTenant();
    const badCursor = Buffer.from(
      JSON.stringify({ created_at: "2026-07-21T00:00:00.000Z" }),
    ).toString("base64url");
    await expect(listAdminExportsByTenant(fx.tenantId, { cursor: badCursor })).rejects.toThrow(
      /cursor 缺少 created_at\/id 字段/,
    );
  });
});

// ─── updateAdminExportStatus ──────────────────────────

describe("updateAdminExportStatus", () => {
  it("running 状态转换：只更新 status + updatedAt，不写审计", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);
    const originalUpdatedAt = record.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: record.id,
      status: "running",
      actor: buildActor(fx.tenantId),
    });

    expect(updated.status).toBe("running");
    expect(updated.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    expect(updated.completedAt).toBeNull();

    // 不写审计事件
    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.failed",
    });
    expect(events).toHaveLength(0);
  });

  it("failed 状态转换：写 failureReason + completedAt + 审计 admin.export.failed", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    const updated = await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: record.id,
      status: "failed",
      failureReason: "downstream service unavailable",
      actor: buildActor(fx.tenantId),
      requestId: "req-fail-001",
    });

    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe("downstream service unavailable");
    expect(updated.completedAt).toBeInstanceOf(Date);

    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.failed",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.requestId).toBe("req-fail-001");
    expect(events[0]?.targetId).toBe(fx.tenantId);
  });

  it("cancelled 状态转换：completedAt 设置但不写审计", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    const updated = await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: record.id,
      status: "cancelled",
      actor: buildActor(fx.tenantId),
    });

    expect(updated.status).toBe("cancelled");
    expect(updated.completedAt).toBeInstanceOf(Date);

    // cancelled 不写 failed 审计
    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.failed",
    });
    expect(events).toHaveLength(0);
  });

  it("failureReason=null 清空 failureReason", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    // 先填 failureReason
    await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: record.id,
      status: "failed",
      failureReason: "first failure",
      actor: buildActor(fx.tenantId),
    });

    // 再清空（用 cancelled 状态演示）
    const updated = await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: record.id,
      status: "cancelled",
      failureReason: null,
      actor: buildActor(fx.tenantId),
    });

    expect(updated.failureReason).toBeNull();
  });
});

// ─── updateAdminExportResult ──────────────────────────

describe("updateAdminExportResult", () => {
  it("写入 resultRef + recordCount + redactionSummary + completedAt + status=completed", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    const updated = await updateAdminExportResult({
      tenantId: fx.tenantId,
      exportId: record.id,
      resultRef: `/admin/api/v1/exports/${record.id}/download`,
      recordCount: 42,
      redactionSummary: "redacted forbidden fields (mode=redacted)",
      actor: buildActor(fx.tenantId),
      requestId: "req-complete-001",
    });

    expect(updated.status).toBe("completed");
    expect(updated.resultRef).toBe(`/admin/api/v1/exports/${record.id}/download`);
    expect(updated.recordCount).toBe(42);
    expect(updated.redactionSummary).toBe("redacted forbidden fields (mode=redacted)");
    expect(updated.completedAt).toBeInstanceOf(Date);
  });

  it("redactionSummary=null 透传（无敏感字段的导出）", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    const updated = await updateAdminExportResult({
      tenantId: fx.tenantId,
      exportId: record.id,
      resultRef: `/admin/api/v1/exports/${record.id}/download`,
      recordCount: 5,
      redactionSummary: null,
      actor: buildActor(fx.tenantId),
    });

    expect(updated.redactionSummary).toBeNull();
    expect(updated.status).toBe("completed");
  });

  it("写审计事件 admin.export.completed", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    await updateAdminExportResult({
      tenantId: fx.tenantId,
      exportId: record.id,
      resultRef: `/admin/api/v1/exports/${record.id}/download`,
      recordCount: 10,
      redactionSummary: null,
      actor: buildActor(fx.tenantId),
      requestId: "req-complete-002",
    });

    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.completed",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe("user");
    expect(events[0]?.actorId).toBe("uid-test-001");
    expect(events[0]?.targetType).toBe("tenant");
    expect(events[0]?.targetId).toBe(fx.tenantId);
    expect(events[0]?.requestId).toBe("req-complete-002");
  });

  it("跨租户更新抛错（行未找到）", async () => {
    const fx = await seedTenant();
    const record = await createDefaultExport(fx.tenantId);

    await expect(
      updateAdminExportResult({
        tenantId: randomUUID(), // 不同租户
        exportId: record.id,
        resultRef: "/download",
        recordCount: 1,
        redactionSummary: null,
        actor: buildActor(fx.tenantId),
      }),
    ).rejects.toThrow(/行未找到/);
  });
});
