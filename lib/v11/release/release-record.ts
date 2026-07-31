/**
 * S13-W08 发布记录生成器。
 *
 * 职责：
 * - 组装发布记录：方案版本、制品摘要、迁移批次、配置、限制、回滚点、负责人。
 * - 门禁校验：必填字段齐全、制品摘要非空、回滚点明确、负责人非空。
 * - 格式化发布记录为可读字符串。
 *
 * 事实源：13-migration-cutover-and-release.md §S13-W08
 *         （发布记录包含方案版本、制品摘要、迁移批次、配置、已知限制、回滚点和负责人）。
 */
import {
  type ArtifactDescriptor,
  type ConfigEntry,
  type MigrationBatchRecord,
  type ReleaseRecord,
  ReleaseRecordGateError,
  type RollbackPointDescriptor,
  V11_SCHEME_VERSION,
} from "@/lib/v11/release/release-contract";

// ─── 发布记录构建器 ────────────────────────────────────────

/** 发布记录构建器输入。 */
export interface ReleaseRecordInput {
  readonly artifactSummary: readonly ArtifactDescriptor[];
  readonly migrationBatches: readonly MigrationBatchRecord[];
  readonly configSnapshot: readonly ConfigEntry[];
  readonly knownLimitations: readonly string[];
  readonly rollbackPoint: RollbackPointDescriptor;
  readonly owner: string;
  readonly oncallRoster: readonly string[];
  readonly releaseNotes: string;
}

/** 构建发布记录。 */
export function buildReleaseRecord(input: ReleaseRecordInput): ReleaseRecord {
  return {
    schemeVersion: V11_SCHEME_VERSION,
    releasedAt: new Date().toISOString(),
    artifactSummary: input.artifactSummary,
    migrationBatches: input.migrationBatches,
    configSnapshot: input.configSnapshot,
    knownLimitations: input.knownLimitations,
    rollbackPoint: input.rollbackPoint,
    owner: input.owner,
    oncallRoster: input.oncallRoster,
    releaseNotes: input.releaseNotes,
  };
}

// ─── 门禁校验 ─────────────────────────────────────────────

/** 校验发布记录门禁：必填字段齐全。 */
export function validateReleaseRecord(record: ReleaseRecord): {
  passed: boolean;
  missingFields: readonly string[];
} {
  const missingFields: string[] = [];

  if (!record.schemeVersion) missingFields.push("schemeVersion");
  if (!record.releasedAt) missingFields.push("releasedAt");
  if (record.artifactSummary.length === 0) missingFields.push("artifactSummary");
  if (record.migrationBatches.length === 0) missingFields.push("migrationBatches");
  if (!record.owner) missingFields.push("owner");
  if (record.oncallRoster.length === 0) missingFields.push("oncallRoster");
  if (!record.rollbackPoint.location) missingFields.push("rollbackPoint.location");
  if (!record.rollbackPoint.owner) missingFields.push("rollbackPoint.owner");

  // 制品摘要完整性
  for (const artifact of record.artifactSummary) {
    if (!artifact.name || !artifact.version || !artifact.digest) {
      missingFields.push(`artifactSummary[${artifact.name || "?"}].incomplete`);
    }
  }

  // 迁移批次状态校验（不允许 failed 状态）
  for (const batch of record.migrationBatches) {
    if (batch.status === "failed") {
      missingFields.push(`migrationBatches[${batch.batchId}].failed`);
    }
  }

  return { passed: missingFields.length === 0, missingFields };
}

/** 门禁断言：必填字段缺失时抛 ReleaseRecordGateError。 */
export function assertReleaseRecordGate(record: ReleaseRecord): void {
  const result = validateReleaseRecord(record);
  if (!result.passed) {
    throw new ReleaseRecordGateError(
      `发布记录门禁失败：缺失字段 ${result.missingFields.join(", ")}`,
      result.missingFields,
    );
  }
}

// ─── 格式化 ───────────────────────────────────────────────

/** 格式化发布记录为可读字符串。 */
export function formatReleaseRecord(record: ReleaseRecord): string {
  const lines: string[] = [];
  lines.push("=== V11 发布记录 ===");
  lines.push(`方案版本：${record.schemeVersion}`);
  lines.push(`发布时间：${record.releasedAt}`);
  lines.push(`负责人：${record.owner}`);
  lines.push(`值守名单：${record.oncallRoster.join(", ")}`);

  lines.push("");
  lines.push("制品摘要：");
  for (const artifact of record.artifactSummary) {
    lines.push(
      `  - ${artifact.name}@${artifact.version} (${artifact.type}) digest: ${artifact.digest}`,
    );
  }

  lines.push("");
  lines.push("迁移批次：");
  for (const batch of record.migrationBatches) {
    lines.push(
      `  - ${batch.batchId}: ${batch.domain} ${batch.recordCount} 条 [${batch.status}] @ ${batch.completedAt}`,
    );
  }

  lines.push("");
  lines.push("配置快照：");
  for (const config of record.configSnapshot) {
    const displayValue = config.sensitive ? "***（脱敏）" : config.value;
    lines.push(`  - ${config.key} = ${displayValue}`);
  }

  lines.push("");
  lines.push("已知限制：");
  if (record.knownLimitations.length === 0) {
    lines.push("  （无）");
  } else {
    for (const limitation of record.knownLimitations) {
      lines.push(`  - ${limitation}`);
    }
  }

  lines.push("");
  lines.push("回滚点：");
  lines.push(`  位置：${record.rollbackPoint.location}`);
  lines.push(`  责任人：${record.rollbackPoint.owner}`);
  lines.push(`  创建时间：${record.rollbackPoint.createdAt}`);
  lines.push("  触发条件：");
  for (const cond of record.rollbackPoint.triggerConditions) {
    lines.push(`    - ${cond}`);
  }

  if (record.releaseNotes) {
    lines.push("");
    lines.push("发布说明：");
    lines.push(record.releaseNotes);
  }

  return lines.join("\n");
}
