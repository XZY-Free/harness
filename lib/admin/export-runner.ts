/**
 * V11 Admin Export Runner（S11-W08）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md（管理导出任务），
 * - ../v11-agentkit-platform-development-plan/11-admin-observability-evaluation-and-capacity.md S11-W08。
 *
 * 职责：
 * - runAdminExport：根据 exportKind 调用对应仓储 list* 函数拉取数据。
 * - 对每条记录调用 content-policy.ts 的 redactContent（强制 redacted 模式，禁采字段被替换）。
 * - 生成 NDJSON 字符串并保存 resultRef + recordCount + redactionSummary 到 DB。
 * - 写审计 admin.export.completed。
 * - 失败时调用 updateAdminExportStatus(status=failed) + failureReason + 审计 admin.export.failed。
 *
 * 关键约束：
 * - 跨租户隔离：所有 list* 调用按 tenantId 过滤。
 * - 导出同样脱敏并审计：禁采字段（Secret/Cookie/验证码/私钥/隐藏思维链）永不导出。
 * - resultRef 形如 /admin/api/v1/exports/{id}/download，download 端点直接读取该引用返回 NDJSON。
 */
import { recordAuditEvent } from "@/lib/identity/audit";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import type { AdminExport, ExportKind } from "@/lib/persistence/schema/admin-export";
import {
 getAdminExportById,
 updateAdminExportResult,
 updateAdminExportStatus,
} from "@/lib/admin/export-queries";
import { listEvaluationRunsByTenant } from "@/lib/evaluation/evaluation-queries";
import { redactContent } from "@/lib/observability/content-policy";
import { listTracesByTenant } from "@/lib/observability/trace-queries";
import {
 listCapacitySnapshotsByTenant,
 listCostAggregatesByTenant,
 listUsageRecordsByTenant,
} from "@/lib/operations/usage-queries";

/** runAdminExport 入参。 */
export interface RunAdminExportParams {
 tenantId: string;
 exportId: string;
 /** 审计 actor（由 route 层从 principal 提取）。 */
 actor: AuditActor;
 /** 关联请求 id。 */
 requestId?: string;
}

/** runAdminExport 结果。 */
export interface RunAdminExportResult {
 export: AdminExport;
 /** NDJSON 字符串（download 端点直接返回）。 */
 ndjson: string;
 /** 实际记录数。 */
 recordCount: number;
 /** 脱敏摘要。 */
 redactionSummary: string | null;
}

/**
 * 执行管理导出。
 *
 * 流程：
 * 1. 读取 export 任务，校验 tenantId 一致 + status=pending。
 * 2. 更新 status=running。
 * 3. 按 exportKind 调用对应 list* 拉取数据。
 * 4. 对每条记录调用 redactContent(mode=redacted) 脱敏。
 * 5. 生成 NDJSON 字符串，写入 resultRef + recordCount + redactionSummary + status=completed。
 * 6. 失败时写 status=failed + failureReason + 审计 admin.export.failed。
 *
 * 失败场景：
 * - 任务不存在或跨租户 → 抛 ResourceNotFound。
 * - 任务状态非 pending → 抛 InvalidStateError。
 * - 数据查询失败 → 写 failed + 抛原错误。
 */
export async function runAdminExport(params: RunAdminExportParams): Promise<RunAdminExportResult> {
 const exportRecord = await getAdminExportById(params.tenantId, params.exportId);
 if (!exportRecord) {
 throw new ExportNotFoundError(params.exportId);
 }
 if (exportRecord.status !== "pending") {
 throw new ExportInvalidStateError(params.exportId, exportRecord.status);
 }

 // 标记 running
 await updateAdminExportStatus({
 tenantId: params.tenantId,
 exportId: params.exportId,
 status: "running",
 actor: params.actor,
 requestId: params.requestId,
 });

 try {
 const rendered = await renderExportNdjson(exportRecord);

 const resultRef = `/admin/api/v1/exports/${params.exportId}/download`;
 const updated = await updateAdminExportResult({
 tenantId: params.tenantId,
 exportId: params.exportId,
 resultRef,
 recordCount: rendered.recordCount,
 redactionSummary: rendered.redactionSummary,
 actor: params.actor,
 requestId: params.requestId,
 });

 return {
 export: updated,
 ndjson: rendered.ndjson,
 recordCount: rendered.recordCount,
 redactionSummary: rendered.redactionSummary,
 };
 } catch (err) {
 const failureReason = err instanceof Error ? err.message.slice(0, 256) : "unknown error";
 await updateAdminExportStatus({
 tenantId: params.tenantId,
 exportId: params.exportId,
 status: "failed",
 failureReason,
 actor: params.actor,
 requestId: params.requestId,
 });
 throw err;
 }
}

/** renderExportNdjson 返回值。 */
export interface RenderExportNdjsonResult {
 /** NDJSON 字符串。 */
 ndjson: string;
 /** 实际记录数。 */
 recordCount: number;
 /** 脱敏摘要。 */
 redactionSummary: string | null;
}

/**
 * 渲染导出内容为 NDJSON（只读，不修改状态）。
 *
 * 供 download 端点复用：从 completed 任务重新拉取数据并脱敏。
 * - 跨租户隔离：所有 list* 调用按 tenantId 过滤。
 * - 强制 redacted 模式：禁采字段被替换为 [REDACTED]。
 *
 * 调用前应校验 exportRecord.status=completed（download 端点）或 pending（runAdminExport）。
 */
export async function renderExportNdjson(exportRecord: {
 tenantId: string;
 exportKind: ExportKind;
 filterJson: Record<string, unknown> | null;
}): Promise<RenderExportNdjsonResult> {
 const records = await fetchExportRecords(
 exportRecord.tenantId,
 exportRecord.exportKind,
 exportRecord.filterJson,
 );

 const redactedLines: string[] = [];
 let anyRedacted = false;
 for (const record of records) {
 const result = redactContent(record, "redacted");
 if (result.redactionSummary) {
 anyRedacted = true;
 }
 redactedLines.push(JSON.stringify(result.content));
 }
 const ndjson = redactedLines.join("\n");
 const redactionSummary = anyRedacted ? "redacted forbidden fields (mode=redacted)" : null;

 return { ndjson, recordCount: records.length, redactionSummary };
}

/**
 * 根据 exportKind 拉取数据。
 *
 * 各 list* 函数均按 tenantId 过滤，跨租户隔离。
 * limit 默认 200（与 list* 函数上限一致），filterJson 可覆盖。
 */
async function fetchExportRecords(
 tenantId: string,
 exportKind: ExportKind,
 filterJson: Record<string, unknown> | null,
): Promise<unknown[]> {
 const limit = typeof filterJson?.limit === "number" ? Math.min(filterJson.limit, 200) : 200;

 switch (exportKind) {
 case "audit_events": {
 const events = await listAuditEvents({ tenantId, limit });
 // 排除 admin.export.* 事件，避免导出自身审计污染数据
 return events.filter((e) => !e.actionType.startsWith("admin.export.")) as unknown[];
 }
 case "usage_records": {
 const result = await listUsageRecordsByTenant(tenantId, { limit });
 return result.items as unknown[];
 }
 case "cost_aggregates": {
 const result = await listCostAggregatesByTenant(tenantId, { limit });
 return result.items as unknown[];
 }
 case "capacity_snapshots": {
 const result = await listCapacitySnapshotsByTenant(tenantId, { limit });
 return result.items as unknown[];
 }
 case "traces": {
 const result = await listTracesByTenant(tenantId, { limit });
 return result.items as unknown[];
 }
 case "evaluation_runs": {
 const result = await listEvaluationRunsByTenant(tenantId, { limit });
 return result.items as unknown[];
 }
 default: {
 // exhaustiveness check
 const _exhaustive: never = exportKind;
 throw new Error(`fetchExportRecords: 未知 exportKind=${String(_exhaustive)}`);
 }
 }
}

/**
 * 写 admin.export.downloaded 审计事件（download 端点调用）。
 *
 * 与 runAdminExport 分离，因为 download 是只读操作但需审计。
 */
export async function recordExportDownloadedAudit(params: {
 actor: AuditActor;
 tenantId: string;
 exportId: string;
 requestId?: string;
}): Promise<void> {
 await recordAuditEvent({
 actor: params.actor,
 actionType: "admin.export.downloaded",
 targetType: "tenant",
 targetId: params.tenantId,
 after: { export_id: params.exportId },
 requestId: params.requestId,
 });
}

// ─── 错误类型 ─────────────────────────────────────────────

/** 导出任务不存在或跨租户隐藏。 */
export class ExportNotFoundError extends Error {
 constructor(public readonly exportId: string) {
 super(`导出任务不存在或无权访问: ${exportId}`);
 this.name = "ExportNotFoundError";
 }
}

/** 导出任务状态非法（非 pending 时执行）。 */
export class ExportInvalidStateError extends Error {
 constructor(
 public readonly exportId: string,
 public readonly currentStatus: string,
 ) {
 super(`导出任务 ${exportId} 状态非 pending（当前 ${currentStatus}），拒绝执行`);
 this.name = "ExportInvalidStateError";
 }
}
