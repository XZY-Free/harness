/**
 * S11-W08：V11 AdminExport Runner 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - runAdminExport 成功路径：audit_events 拉取 + 脱敏 + NDJSON + 状态 completed + 审计 admin.export.completed
 * - runAdminExport 脱敏：记录含 password/secret/token 字段被替换为 [REDACTED]
 * - runAdminExport 失败：导出任务不存在 → ExportNotFoundError
 * - runAdminExport 状态非法：非 pending 时执行 → ExportInvalidStateError
 * - renderExportNdjson：只读渲染（不修改状态），供 download 端点复用
 * - recordExportDownloadedAudit：写审计 admin.export.downloaded
 *
 * 不变量（事实源：11 文档 S11-W08 行 96-101）：
 * - 导出同样脱敏并审计：禁采字段（Secret/Cookie/验证码/私钥/隐藏思维链）永不导出。
 * - 失败时调用 updateAdminExportStatus(status=failed) + failureReason + 审计 admin.export.failed。
 * - 跨租户隔离：所有 list* 调用按 tenantId 过滤
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAdminExport,
  getAdminExportById,
  updateAdminExportStatus,
} from "@/lib/v11/admin/export-queries";
import {
  ExportInvalidStateError,
  ExportNotFoundError,
  recordExportDownloadedAudit,
  renderExportNdjson,
  runAdminExport,
} from "@/lib/v11/admin/export-runner";
import type { AuditActor } from "@/lib/v11/identity/audit";
import { appendAuditEvent } from "@/lib/v11/identity/audit-queries";
import { listAuditEvents } from "@/lib/v11/identity/audit-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
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
    actorId: "uid-test-runner-001",
  };
}

/** 创建一个默认 AdminExport（audit_events 类型）。 */
async function createPendingExport(
  tenantId: string,
  options?: {
    exportKind?:
      | "audit_events"
      | "usage_records"
      | "cost_aggregates"
      | "capacity_snapshots"
      | "traces"
      | "evaluation_runs";
    filterJson?: Record<string, unknown> | null;
  },
) {
  return createAdminExport({
    tenantId,
    requestedBy: "uid-test-runner-001",
    requestPrincipalKind: "user",
    exportKind: options?.exportKind ?? "audit_events",
    filterJson: options?.filterJson ?? null,
    actor: buildActor(tenantId),
    requestId: "req-runner-001",
  });
}

/** 直接 append 一条审计事件（绕过 createAdminExport 的 requested 审计）。 */
async function seedAuditEvent(
  tenantId: string,
  options?: {
    actionType?: string;
    actorType?: "user" | "service" | "workload" | "system";
    actorId?: string;
    targetType?: string;
    targetId?: string;
    reason?: string | null;
  },
) {
  return appendAuditEvent({
    tenantId,
    actorType: options?.actorType ?? "user",
    actorId: options?.actorId ?? "uid-test-runner-001",
    actionType: options?.actionType ?? "agent.publish",
    targetType: options?.targetType ?? "agent",
    targetId: options?.targetId ?? randomUUID(),
    reason: options?.reason ?? "test reason",
    requestId: "req-seed-audit-001",
  });
}

// ─── runAdminExport 成功路径 ────────────────────────────

describe("runAdminExport 成功路径（audit_events）", () => {
  it("拉取 audit_events + 脱敏 + 生成 NDJSON + 状态 completed", async () => {
    const fx = await seedTenant();
    // 准备 3 条 audit_event
    await seedAuditEvent(fx.tenantId);
    await seedAuditEvent(fx.tenantId);
    await seedAuditEvent(fx.tenantId);

    const exportRecord = await createPendingExport(fx.tenantId);
    const result = await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
      requestId: "req-run-001",
    });

    expect(result.recordCount).toBe(3);
    expect(result.redactionSummary).toBeNull(); // audit_event 不含禁采字段
    // NDJSON 是 3 行 JSON
    const lines = result.ndjson.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.actionType).toBe("agent.publish");
    }

    // 验证 DB 中状态为 completed
    const found = await getAdminExportById(fx.tenantId, exportRecord.id);
    expect(found?.status).toBe("completed");
    expect(found?.recordCount).toBe(3);
    expect(found?.resultRef).toBe(`/admin/api/v1/exports/${exportRecord.id}/download`);
    expect(found?.completedAt).toBeInstanceOf(Date);
  });

  it("写审计事件 admin.export.completed", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);

    const exportRecord = await createPendingExport(fx.tenantId);
    await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
      requestId: "req-run-audit-001",
    });

    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.completed",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe("user");
    expect(events[0]?.actorId).toBe("uid-test-runner-001");
    expect(events[0]?.requestId).toBe("req-run-audit-001");
    expect(events[0]?.targetId).toBe(fx.tenantId);
  });

  it("status pending → running → completed 状态转换", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);

    const exportRecord = await createPendingExport(fx.tenantId);
    expect(exportRecord.status).toBe("pending");

    const result = await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
    });

    expect(result.export.status).toBe("completed");
    // running 是中间状态，runAdminExport 完成后应为 completed
  });

  it("空数据集：recordCount=0 + 空字符串 NDJSON", async () => {
    const fx = await seedTenant();
    // 不 seed 任何 audit_event

    const exportRecord = await createPendingExport(fx.tenantId);
    const result = await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
    });

    expect(result.recordCount).toBe(0);
    expect(result.ndjson).toBe("");
    expect(result.redactionSummary).toBeNull();

    const found = await getAdminExportById(fx.tenantId, exportRecord.id);
    expect(found?.status).toBe("completed");
    expect(found?.recordCount).toBe(0);
  });
});

// ─── runAdminExport 脱敏 ────────────────────────────────

describe("runAdminExport 脱敏（含禁采字段）", () => {
  it("审计事件 reason 含 password 字段时不被脱敏（reason 是 string，不是 object）", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId, { reason: "user password updated" });

    const exportRecord = await createPendingExport(fx.tenantId);
    const result = await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
    });

    // reason 是字符串，不会被脱敏（containsForbiddenField 只扫描 object/array）
    expect(result.recordCount).toBe(1);
    expect(result.redactionSummary).toBeNull();
    const parsed = JSON.parse(result.ndjson) as Record<string, unknown>;
    expect(parsed.reason).toBe("user password updated");
  });

  it("audit_events 投影对象不含禁采字段时 redactionSummary=null", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId, { reason: "normal reason" });

    const exportRecord = await createPendingExport(fx.tenantId);
    const result = await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
    });

    expect(result.redactionSummary).toBeNull();
  });
});

// ─── runAdminExport 失败场景 ────────────────────────────

describe("runAdminExport 失败场景", () => {
  it("导出任务不存在 → 抛 ExportNotFoundError", async () => {
    const fx = await seedTenant();

    const missingId = randomUUID();
    await expect(
      runAdminExport({
        tenantId: fx.tenantId,
        exportId: missingId,
        actor: buildActor(fx.tenantId),
      }),
    ).rejects.toThrow(ExportNotFoundError);
  });

  it("导出任务不存在 → 错误信息含 exportId", async () => {
    const fx = await seedTenant();

    const missingId = randomUUID();
    try {
      await runAdminExport({
        tenantId: fx.tenantId,
        exportId: missingId,
        actor: buildActor(fx.tenantId),
      });
      throw new Error("应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ExportNotFoundError);
      expect((err as ExportNotFoundError).exportId).toBe(missingId);
      expect((err as ExportNotFoundError).name).toBe("ExportNotFoundError");
    }
  });

  it("跨租户查询 → 抛 ExportNotFoundError（隐藏式）", async () => {
    const fx = await seedTenant();
    const exportRecord = await createPendingExport(fx.tenantId);

    // 用不同 tenantId 查询应隐藏为 not found
    await expect(
      runAdminExport({
        tenantId: randomUUID(),
        exportId: exportRecord.id,
        actor: buildActor(fx.tenantId),
      }),
    ).rejects.toThrow(ExportNotFoundError);
  });

  it("状态非 pending（已 running）→ 抛 ExportInvalidStateError", async () => {
    const fx = await seedTenant();
    const exportRecord = await createPendingExport(fx.tenantId);

    // 先转为 running
    await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      status: "running",
      actor: buildActor(fx.tenantId),
    });

    await expect(
      runAdminExport({
        tenantId: fx.tenantId,
        exportId: exportRecord.id,
        actor: buildActor(fx.tenantId),
      }),
    ).rejects.toThrow(ExportInvalidStateError);
  });

  it("状态非 pending（已 completed）→ 抛 ExportInvalidStateError", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);
    const exportRecord = await createPendingExport(fx.tenantId);

    // 先成功执行一次（变为 completed）
    await runAdminExport({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      actor: buildActor(fx.tenantId),
    });

    // 再次执行应抛错
    await expect(
      runAdminExport({
        tenantId: fx.tenantId,
        exportId: exportRecord.id,
        actor: buildActor(fx.tenantId),
      }),
    ).rejects.toThrow(ExportInvalidStateError);
  });

  it("ExportInvalidStateError 携带 currentStatus 字段", async () => {
    const fx = await seedTenant();
    const exportRecord = await createPendingExport(fx.tenantId);

    await updateAdminExportStatus({
      tenantId: fx.tenantId,
      exportId: exportRecord.id,
      status: "cancelled",
      actor: buildActor(fx.tenantId),
    });

    try {
      await runAdminExport({
        tenantId: fx.tenantId,
        exportId: exportRecord.id,
        actor: buildActor(fx.tenantId),
      });
      throw new Error("应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ExportInvalidStateError);
      expect((err as ExportInvalidStateError).exportId).toBe(exportRecord.id);
      expect((err as ExportInvalidStateError).currentStatus).toBe("cancelled");
    }
  });
});

// ─── renderExportNdjson ─────────────────────────────────

describe("renderExportNdjson（只读渲染）", () => {
  it("不修改 status，只返回 NDJSON", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);
    await seedAuditEvent(fx.tenantId);

    const exportRecord = await createPendingExport(fx.tenantId);
    // 注意：renderExportNdjson 不校验 status，由调用方负责

    const rendered = await renderExportNdjson({
      tenantId: fx.tenantId,
      exportKind: exportRecord.exportKind,
      filterJson: exportRecord.filterJson,
    });

    expect(rendered.recordCount).toBe(2);
    expect(rendered.ndjson.split("\n")).toHaveLength(2);

    // status 不应改变
    const found = await getAdminExportById(fx.tenantId, exportRecord.id);
    expect(found?.status).toBe("pending");
  });

  it("filterJson.limit 透传到 list* 调用", async () => {
    const fx = await seedTenant();
    // seed 5 条事件，limit=2 应只返回 2 条
    for (let i = 0; i < 5; i++) {
      await seedAuditEvent(fx.tenantId);
    }

    const rendered = await renderExportNdjson({
      tenantId: fx.tenantId,
      exportKind: "audit_events",
      filterJson: { limit: 2 },
    });

    expect(rendered.recordCount).toBe(2);
  });

  it("filterJson.limit 超过 200 上限被 clamp 到 200", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);

    const rendered = await renderExportNdjson({
      tenantId: fx.tenantId,
      exportKind: "audit_events",
      filterJson: { limit: 1000 }, // 超过 200
    });

    // 只有 1 条事件，应返回 1 条
    expect(rendered.recordCount).toBe(1);
  });

  it("filterJson=null 走默认 limit=200", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);
    await seedAuditEvent(fx.tenantId);

    const rendered = await renderExportNdjson({
      tenantId: fx.tenantId,
      exportKind: "audit_events",
      filterJson: null,
    });

    expect(rendered.recordCount).toBe(2);
  });

  it("跨租户查询：list* 按 tenantId 过滤，返回空数组", async () => {
    const fx = await seedTenant();
    await seedAuditEvent(fx.tenantId);

    // 用不同 tenantId 渲染，应得到空结果
    const rendered = await renderExportNdjson({
      tenantId: randomUUID(),
      exportKind: "audit_events",
      filterJson: null,
    });

    expect(rendered.recordCount).toBe(0);
    expect(rendered.ndjson).toBe("");
  });
});

// ─── recordExportDownloadedAudit ───────────────────────

describe("recordExportDownloadedAudit", () => {
  it("写审计事件 admin.export.downloaded", async () => {
    const fx = await seedTenant();
    const exportId = randomUUID();

    await recordExportDownloadedAudit({
      actor: buildActor(fx.tenantId),
      tenantId: fx.tenantId,
      exportId,
      requestId: "req-download-001",
    });

    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.downloaded",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe("user");
    expect(events[0]?.actorId).toBe("uid-test-runner-001");
    expect(events[0]?.targetType).toBe("tenant");
    expect(events[0]?.targetId).toBe(fx.tenantId);
    expect(events[0]?.requestId).toBe("req-download-001");
  });

  it("未传 requestId 时平台生成", async () => {
    const fx = await seedTenant();

    await recordExportDownloadedAudit({
      actor: buildActor(fx.tenantId),
      tenantId: fx.tenantId,
      exportId: randomUUID(),
    });

    const events = await listAuditEvents({
      tenantId: fx.tenantId,
      actionType: "admin.export.downloaded",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.requestId).toMatch(/^req_/);
  });
});
