/**
 * S13-W04 切换前置检查：备份、恢复点、容量、告警、值守、回滚责任确认。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W04
 *         （切换前完成备份、恢复点、容量预热、告警静默边界、值守与回滚责任确认）。
 *
 * 设计：
 * - 抽象检查项接口 Precheck，每项返回 pass/fail + 详情。
 * - 每项检查可注册自定义实现（生产由运维平台提供）。
 * - 阻断性检查（blocking）未通过时不允许进入 backup_ready 状态。
 * - 检查结果汇总为 PrecheckReport，支持机器可读与人可审阅。
 */
import type { CutoverSession } from "@/lib/v11/cutover/session-store";

// ─── 检查项类型 ──────────────────────────────────────────────

/** 检查严重级别。 */
export type PrecheckSeverity = "blocking" | "warning" | "info";

/** 单项前置检查结果。 */
export interface PrecheckResult {
  /** 检查项名称。 */
  readonly name: string;
  /** 严重级别。 */
  readonly severity: PrecheckSeverity;
  /** 是否通过。 */
  readonly passed: boolean;
  /** 详情（失败时描述原因与修复建议）。 */
  readonly details: string;
  /** 检查时间戳（ISO 字符串）。 */
  readonly timestamp: string;
}

/** 前置检查汇总报告。 */
export interface PrecheckReport {
  /** 关联会话 ID。 */
  readonly sessionId: string;
  /** 检查结果列表。 */
  readonly results: readonly PrecheckResult[];
  /** 通过检查数。 */
  readonly passedCount: number;
  /** 失败检查数（仅 blocking）。 */
  readonly failedCount: number;
  /** 警告检查数。 */
  readonly warningCount: number;
  /** 是否全部通过（所有 blocking 检查通过）。 */
  readonly passed: boolean;
  /** 阻断性问题列表。 */
  readonly blockingIssues: readonly string[];
  /** 生成时间（ISO 字符串）。 */
  readonly generatedAt: string;
}

// ─── 检查项接口 ──────────────────────────────────────────────

/** 单项前置检查接口。 */
export interface Precheck {
  /** 检查项名称。 */
  readonly name: string;
  /** 严重级别。 */
  readonly severity: PrecheckSeverity;
  /** 执行检查（返回 passed + details）。 */
  run(session: CutoverSession): Promise<PrecheckResult>;
}

// ─── 标准检查项 ──────────────────────────────────────────────

/** 备份已就绪检查（blocking）。 */
export class BackupReadyCheck implements Precheck {
  readonly name = "备份已就绪";
  readonly severity: PrecheckSeverity = "blocking";

  constructor(private readonly backupProvider: BackupProvider) {}

  async run(session: CutoverSession): Promise<PrecheckResult> {
    const timestamp = new Date().toISOString();
    try {
      const result = await this.backupProvider.verifyBackup(session.id);
      if (!result.ready) {
        return {
          name: this.name,
          severity: this.severity,
          passed: false,
          details: `备份未就绪：${result.reason}`,
          timestamp,
        };
      }
      return {
        name: this.name,
        severity: this.severity,
        passed: true,
        details: `备份就绪，恢复点：${result.restorePointId}`,
        timestamp,
      };
    } catch (err) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: `备份检查执行失败：${err instanceof Error ? err.message : String(err)}`,
        timestamp,
      };
    }
  }
}

/** 恢复点已验证检查（blocking）。 */
export class RestorePointVerifiedCheck implements Precheck {
  readonly name = "恢复点已验证";
  readonly severity: PrecheckSeverity = "blocking";

  constructor(private readonly backupProvider: BackupProvider) {}

  async run(session: CutoverSession): Promise<PrecheckResult> {
    const timestamp = new Date().toISOString();
    if (!session.backupRestorePoint) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: "会话未记录备份恢复点（须先通过 backup_ready 阶段）",
        timestamp,
      };
    }
    try {
      const verified = await this.backupProvider.verifyRestorePoint(session.backupRestorePoint);
      return {
        name: this.name,
        severity: this.severity,
        passed: verified,
        details: verified
          ? `恢复点 ${session.backupRestorePoint} 验证通过`
          : `恢复点 ${session.backupRestorePoint} 验证失败`,
        timestamp,
      };
    } catch (err) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: `恢复点验证执行失败：${err instanceof Error ? err.message : String(err)}`,
        timestamp,
      };
    }
  }
}

/** 容量预热检查（blocking）。 */
export class CapacityPrecheck implements Precheck {
  readonly name = "容量预热完成";
  readonly severity: PrecheckSeverity = "blocking";

  constructor(private readonly capacityProvider: CapacityProvider) {}

  async run(session: CutoverSession): Promise<PrecheckResult> {
    const timestamp = new Date().toISOString();
    try {
      const result = await this.capacityProvider.checkCapacity(session.id);
      return {
        name: this.name,
        severity: this.severity,
        passed: result.ready,
        details: result.ready ? `容量预热完成：${result.details}` : `容量未就绪：${result.details}`,
        timestamp,
      };
    } catch (err) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: `容量检查执行失败：${err instanceof Error ? err.message : String(err)}`,
        timestamp,
      };
    }
  }
}

/** 告警静默边界检查（warning）。 */
export class AlertSilenceCheck implements Precheck {
  readonly name = "告警静默边界已配置";
  readonly severity: PrecheckSeverity = "warning";

  constructor(private readonly alertProvider: AlertProvider) {}

  async run(session: CutoverSession): Promise<PrecheckResult> {
    const timestamp = new Date().toISOString();
    try {
      const result = await this.alertProvider.verifySilence(session.id);
      return {
        name: this.name,
        severity: this.severity,
        passed: result.configured,
        details: result.configured
          ? `告警静默已配置：${result.details}`
          : `告警静默未配置：${result.details}`,
        timestamp,
      };
    } catch (err) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: `告警静默检查失败：${err instanceof Error ? err.message : String(err)}`,
        timestamp,
      };
    }
  }
}

/** 值守人员已确认检查（blocking）。 */
export class OnCallOperatorCheck implements Precheck {
  readonly name = "值守人员已确认";
  readonly severity: PrecheckSeverity = "blocking";

  async run(session: CutoverSession): Promise<PrecheckResult> {
    const timestamp = new Date().toISOString();
    if (!session.onCallOperator) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: "值守人员未指定",
        timestamp,
      };
    }
    return {
      name: this.name,
      severity: this.severity,
      passed: true,
      details: `值守人员：${session.onCallOperator}`,
      timestamp,
    };
  }
}

/** 回滚责任人已确认检查（blocking）。 */
export class RollbackOwnerCheck implements Precheck {
  readonly name = "回滚责任人已确认";
  readonly severity: PrecheckSeverity = "blocking";

  async run(session: CutoverSession): Promise<PrecheckResult> {
    const timestamp = new Date().toISOString();
    if (!session.rollbackOwner) {
      return {
        name: this.name,
        severity: this.severity,
        passed: false,
        details: "回滚责任人未指定",
        timestamp,
      };
    }
    return {
      name: this.name,
      severity: this.severity,
      passed: true,
      details: `回滚责任人：${session.rollbackOwner}`,
      timestamp,
    };
  }
}

// ─── Provider 接口（生产由运维平台实现） ──────────────────

/** 备份 Provider 接口。 */
export interface BackupProvider {
  /** 验证备份是否就绪。 */
  verifyBackup(
    sessionId: string,
  ): Promise<{ ready: boolean; restorePointId: string; reason: string }>;
  /** 验证恢复点是否可用。 */
  verifyRestorePoint(restorePointId: string): Promise<boolean>;
}

/** 容量 Provider 接口。 */
export interface CapacityProvider {
  /** 检查容量预热状态。 */
  checkCapacity(sessionId: string): Promise<{ ready: boolean; details: string }>;
}

/** 告警 Provider 接口。 */
export interface AlertProvider {
  /** 验证告警静默边界是否已配置。 */
  verifySilence(sessionId: string): Promise<{ configured: boolean; details: string }>;
}

// ─── 检查执行器 ──────────────────────────────────────────────

/**
 * 执行全部前置检查并生成报告。
 * @param session 切换会话
 * @param checks 检查项列表
 */
export async function runPrechecks(
  session: CutoverSession,
  checks: readonly Precheck[],
): Promise<PrecheckReport> {
  const results: PrecheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check.run(session));
    } catch (err) {
      results.push({
        name: check.name,
        severity: check.severity,
        passed: false,
        details: `检查执行异常：${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const blockingResults = results.filter((r) => r.severity === "blocking");
  const passedCount = blockingResults.filter((r) => r.passed).length;
  const failedCount = blockingResults.filter((r) => !r.passed).length;
  const warningCount = results.filter((r) => r.severity === "warning" && !r.passed).length;
  const blockingIssues = results
    .filter((r) => r.severity === "blocking" && !r.passed)
    .map((r) => `${r.name}: ${r.details}`);

  return {
    sessionId: session.id,
    results,
    passedCount,
    failedCount,
    warningCount,
    passed: failedCount === 0,
    blockingIssues,
    generatedAt: new Date().toISOString(),
  };
}

/** 将前置检查报告格式化为可读字符串。 */
export function formatPrecheckReport(report: PrecheckReport): string {
  const lines: string[] = [
    "V11 切换前置检查报告",
    `会话 ID: ${report.sessionId}`,
    `生成时间: ${report.generatedAt}`,
    "",
    "总计:",
    `  通过: ${report.passedCount}`,
    `  失败: ${report.failedCount}`,
    `  警告: ${report.warningCount}`,
    `  总体: ${report.passed ? "通过" : "未通过"}`,
    "",
  ];

  if (report.blockingIssues.length > 0) {
    lines.push("阻断性问题:");
    for (const issue of report.blockingIssues) {
      lines.push(`  ! ${issue}`);
    }
    lines.push("");
  }

  lines.push("检查详情:");
  for (const result of report.results) {
    const status = result.passed ? "✓" : "×";
    const severity =
      result.severity === "blocking"
        ? "[阻断]"
        : result.severity === "warning"
          ? "[警告]"
          : "[信息]";
    lines.push(`  ${status} ${severity} ${result.name}: ${result.details}`);
  }

  return lines.join("\n");
}
