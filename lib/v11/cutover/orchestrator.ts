import type { Precheck, PrecheckReport } from "@/lib/v11/cutover/precheck";
import { runPrechecks } from "@/lib/v11/cutover/precheck";
import type { RollbackController } from "@/lib/v11/cutover/rollback";
/**
 * S13-W04 切换编排器：按步骤编排切换窗口流程，失败自动触发回滚。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W04
 *         （切换前完成备份、恢复点、容量预热、告警静默边界、值守与回滚责任确认；
 *           先冻结旧写入口并等待进行中的 Invocation/ToolCall/Effect 到安全点，再执行最后增量迁移；
 *           不启用长期双写；切换窗口内只允许明确的只读核对和一次最终增量；
 *           冻结或切换失败时恢复旧入口）。
 *
 * 编排步骤：
 *   1. startSession: 创建会话，指定值守人员与回滚责任人
 *   2. runPrecheck: 执行前置检查（备份/恢复点/容量/告警/值守/回滚责任）
 *   3. prepareBackup: 创建备份与恢复点
 *   4. freezeWrites: 冻结旧写入口
 *   5. drainInFlight: 等待进行中操作到安全点
 *   6. runIncrementalMigration: 执行最终增量迁移
 *   7. verifyConsistency: 验证迁移后一致性
 *   8. completeCutover: 完成切换（V11 对员工开放）
 *
 * 任一步骤失败自动触发回滚，回滚失败则记录致命错误。
 */
import type { CutoverSession, CutoverSessionStore } from "@/lib/v11/cutover/session-store";
import type { CutoverState } from "@/lib/v11/cutover/state-machine";
import {
  buildStepRecord,
  isLegalTransition,
  runTransitionGuards,
} from "@/lib/v11/cutover/state-machine";
import type { WriteFreezeController } from "@/lib/v11/cutover/write-freeze";

// ─── 编排器依赖接口 ──────────────────────────────────────────

/** 备份执行器接口（prepareBackup 步骤用）。 */
export interface BackupExecutor {
  /** 创建备份并返回恢复点 ID。 */
  createBackup(sessionId: string): Promise<{ restorePointId: string; details: string }>;
}

/** 增量迁移执行器接口（runIncrementalMigration 步骤用）。 */
export interface IncrementalMigrationExecutor {
  /** 执行最终增量迁移，返回批次 ID 与计数。 */
  runIncrementalMigration(sessionId: string): Promise<{
    batchId: string;
    migratedCount: number;
    skippedCount: number;
    anomalyCount: number;
  }>;
}

/** 一致性验证器接口（verifyConsistency 步骤用）。 */
export interface ConsistencyVerifier {
  /** 验证迁移后一致性，返回是否通过与详情。 */
  verify(sessionId: string): Promise<{ passed: boolean; details: string }>;
}

/** V11 入口开放器接口（completeCutover 步骤用）。 */
export interface V11EntryOpener {
  /** 将 V11 入口对员工开放。 */
  openV11Entry(sessionId: string): Promise<void>;
}

// ─── 编排器选项 ──────────────────────────────────────────────

/** 切换编排器选项。 */
export interface CutoverOrchestratorOptions {
  readonly sessionStore: CutoverSessionStore;
  readonly writeFreeze: WriteFreezeController;
  readonly rollbackController: RollbackController;
  readonly prechecks: readonly Precheck[];
  readonly backupExecutor: BackupExecutor;
  readonly incrementalMigrationExecutor: IncrementalMigrationExecutor;
  readonly consistencyVerifier: ConsistencyVerifier;
  readonly v11EntryOpener: V11EntryOpener;
  /** 进行中操作排空超时（毫秒），默认 5 分钟。 */
  readonly drainTimeoutMs?: number;
  /** 进行中操作轮询间隔（毫秒），默认 5 秒。 */
  readonly drainPollIntervalMs?: number;
}

// ─── 编排步骤结果 ──────────────────────────────────────────

/** 单个编排步骤结果。 */
export interface OrchestratorStepResult {
  readonly stepName: string;
  readonly fromState: CutoverState;
  readonly toState: CutoverState;
  readonly success: boolean;
  readonly details: string;
  readonly timestamp: string;
}

/** 完整编排结果。 */
export interface CutoverOrchestrationResult {
  readonly success: boolean;
  readonly sessionId: string;
  readonly finalState: CutoverState;
  readonly steps: readonly OrchestratorStepResult[];
  readonly precheckReport: PrecheckReport | null;
  readonly error: string | null;
  readonly rolledBack: boolean;
  readonly rollbackError: string | null;
}

// ─── 切换编排器 ──────────────────────────────────────────

/** 切换编排器：按步骤执行切换窗口流程。 */
export class CutoverOrchestrator {
  constructor(private readonly options: CutoverOrchestratorOptions) {}

  /**
   * 执行完整切换流程。
   * @param initiatedBy 发起人
   * @param onCallOperator 值守人员
   * @param rollbackOwner 回滚责任人
   */
  async executeCutover(
    initiatedBy: string,
    onCallOperator: string,
    rollbackOwner: string,
  ): Promise<CutoverOrchestrationResult> {
    const { sessionStore } = this.options;
    const steps: OrchestratorStepResult[] = [];
    let precheckReport: PrecheckReport | null = null;

    // 步骤 1：创建会话
    let session = sessionStore.createSession(initiatedBy);
    session = sessionStore.updateSession(session.id, {
      onCallOperator,
      rollbackOwner,
    });

    // 步骤 2：idle → precheck
    const precheckTransition = await this.transition(
      session.id,
      "idle",
      "precheck",
      initiatedBy,
      "启动前置检查",
    );
    steps.push(precheckTransition);
    if (!precheckTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, precheckTransition.details);
    }
    session = sessionStore.getSession(session.id) as CutoverSession;

    // 执行前置检查
    try {
      precheckReport = await runPrechecks(session, this.options.prechecks);
      if (!precheckReport.passed) {
        const details = `前置检查未通过：${precheckReport.blockingIssues.join("; ")}`;
        const failStep = this.buildStepResult("前置检查", "precheck", "precheck", false, details);
        steps.push(failStep);
        return this.failWithRollback(session, steps, precheckReport, details);
      }
      steps.push(
        this.buildStepResult(
          "前置检查",
          "precheck",
          "precheck",
          true,
          `前置检查全部通过（${precheckReport.passedCount} 项）`,
        ),
      );
    } catch (err) {
      const details = `前置检查执行异常：${err instanceof Error ? err.message : String(err)}`;
      steps.push(this.buildStepResult("前置检查", "precheck", "precheck", false, details));
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // 步骤 3：precheck → backup_ready（创建备份）
    const backupTransition = await this.transition(
      session.id,
      "precheck",
      "backup_ready",
      initiatedBy,
      "前置检查通过，准备备份",
    );
    steps.push(backupTransition);
    if (!backupTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, backupTransition.details);
    }
    session = sessionStore.getSession(session.id) as CutoverSession;

    try {
      const backupResult = await this.options.backupExecutor.createBackup(session.id);
      session = sessionStore.updateSession(session.id, {
        backupRestorePoint: backupResult.restorePointId,
      });
      steps.push(
        this.buildStepResult(
          "创建备份",
          "backup_ready",
          "backup_ready",
          true,
          `备份就绪，恢复点：${backupResult.restorePointId}（${backupResult.details}）`,
        ),
      );
    } catch (err) {
      const details = `创建备份失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push(this.buildStepResult("创建备份", "backup_ready", "backup_ready", false, details));
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // 步骤 4：backup_ready → write_frozen（冻结旧写入）
    const freezeTransition = await this.transition(
      session.id,
      "backup_ready",
      "write_frozen",
      initiatedBy,
      "备份就绪，冻结旧写入口",
    );
    steps.push(freezeTransition);
    if (!freezeTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, freezeTransition.details);
    }
    session = sessionStore.getSession(session.id) as CutoverSession;

    try {
      await this.options.writeFreeze.freezeAll(session, initiatedBy, "切换窗口启动，冻结旧写入口");
      session = sessionStore.updateSession(session.id, {
        cutoverWindowStartedAt: new Date().toISOString(),
      });
      steps.push(
        this.buildStepResult(
          "冻结旧写入口",
          "write_frozen",
          "write_frozen",
          true,
          "全部旧写入口已冻结",
        ),
      );
    } catch (err) {
      const details = `冻结旧写入口失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push(
        this.buildStepResult("冻结旧写入口", "write_frozen", "write_frozen", false, details),
      );
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // 步骤 5：write_frozen → drained（排空进行中操作）
    const drainTransition = await this.transition(
      session.id,
      "write_frozen",
      "drained",
      initiatedBy,
      "旧写入已冻结，排空进行中操作",
    );
    steps.push(drainTransition);
    if (!drainTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, drainTransition.details);
    }
    session = sessionStore.getSession(session.id) as CutoverSession;

    try {
      await this.drainInFlight(session.id);
      steps.push(
        this.buildStepResult("排空进行中操作", "drained", "drained", true, "进行中操作已到安全点"),
      );
    } catch (err) {
      const details = `排空进行中操作失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push(this.buildStepResult("排空进行中操作", "drained", "drained", false, details));
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // 步骤 6：drained → incremental_migration（最终增量迁移）
    const incrementalTransition = await this.transition(
      session.id,
      "drained",
      "incremental_migration",
      initiatedBy,
      "进行中操作已排空，执行最终增量迁移",
    );
    steps.push(incrementalTransition);
    if (!incrementalTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, incrementalTransition.details);
    }
    session = sessionStore.getSession(session.id) as CutoverSession;

    try {
      const migrationResult =
        await this.options.incrementalMigrationExecutor.runIncrementalMigration(session.id);
      session = sessionStore.updateSession(session.id, {
        incrementalBatchId: migrationResult.batchId,
      });
      if (migrationResult.anomalyCount > 0) {
        const details = `增量迁移存在 ${migrationResult.anomalyCount} 条异常，未通过一致性核对`;
        steps.push(
          this.buildStepResult(
            "最终增量迁移",
            "incremental_migration",
            "incremental_migration",
            false,
            details,
          ),
        );
        return this.failWithRollback(session, steps, precheckReport, details);
      }
      steps.push(
        this.buildStepResult(
          "最终增量迁移",
          "incremental_migration",
          "incremental_migration",
          true,
          `增量迁移完成：迁移 ${migrationResult.migratedCount}，跳过 ${migrationResult.skippedCount}`,
        ),
      );
    } catch (err) {
      const details = `增量迁移执行失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push(
        this.buildStepResult(
          "最终增量迁移",
          "incremental_migration",
          "incremental_migration",
          false,
          details,
        ),
      );
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // 步骤 7：incremental_migration → cutover_ready（一致性核对）
    const readyTransition = await this.transition(
      session.id,
      "incremental_migration",
      "cutover_ready",
      initiatedBy,
      "增量迁移完成，执行一致性核对",
    );
    steps.push(readyTransition);
    if (!readyTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, readyTransition.details);
    }
    session = sessionStore.getSession(session.id) as CutoverSession;

    try {
      const consistencyResult = await this.options.consistencyVerifier.verify(session.id);
      if (!consistencyResult.passed) {
        const details = `一致性核对未通过：${consistencyResult.details}`;
        steps.push(
          this.buildStepResult("一致性核对", "cutover_ready", "cutover_ready", false, details),
        );
        return this.failWithRollback(session, steps, precheckReport, details);
      }
      steps.push(
        this.buildStepResult(
          "一致性核对",
          "cutover_ready",
          "cutover_ready",
          true,
          `一致性核对通过：${consistencyResult.details}`,
        ),
      );
    } catch (err) {
      const details = `一致性核对执行失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push(
        this.buildStepResult("一致性核对", "cutover_ready", "cutover_ready", false, details),
      );
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // 步骤 8：开放 V11 入口（先执行操作，成功后才转换到 cutover_completed 终态）
    try {
      await this.options.v11EntryOpener.openV11Entry(session.id);
      steps.push(
        this.buildStepResult(
          "开放 V11 入口",
          "cutover_ready",
          "cutover_ready",
          true,
          "V11 入口已对员工开放",
        ),
      );
    } catch (err) {
      const details = `开放 V11 入口失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push(
        this.buildStepResult("开放 V11 入口", "cutover_ready", "cutover_ready", false, details),
      );
      // 此时状态仍为 cutover_ready，可以回滚
      return this.failWithRollback(session, steps, precheckReport, details);
    }

    // V11 入口开放成功后才转换到终态 cutover_completed
    const completeTransition = await this.transition(
      session.id,
      "cutover_ready",
      "cutover_completed",
      initiatedBy,
      "V11 入口已开放，完成切换",
    );
    steps.push(completeTransition);
    if (!completeTransition.success) {
      return this.failWithRollback(session, steps, precheckReport, completeTransition.details);
    }
    session = sessionStore.updateSession(session.id, {
      completedAt: new Date().toISOString(),
    });

    return {
      success: true,
      sessionId: session.id,
      finalState: "cutover_completed",
      steps,
      precheckReport,
      error: null,
      rolledBack: false,
      rollbackError: null,
    };
  }

  // ─── 内部辅助 ──────────────────────────────────────────

  /** 执行状态转换并记录步骤。 */
  private async transition(
    sessionId: string,
    from: CutoverState,
    to: CutoverState,
    operator: string,
    reason: string,
  ): Promise<OrchestratorStepResult> {
    const { sessionStore } = this.options;
    const session = sessionStore.getSession(sessionId);
    if (!session) {
      return this.buildStepResult("状态转换", from, to, false, `会话不存在：${sessionId}`);
    }

    if (session.state !== from) {
      return this.buildStepResult(
        "状态转换",
        from,
        to,
        false,
        `当前状态 ${session.state} 与预期 ${from} 不符`,
      );
    }

    if (!isLegalTransition(from, to)) {
      return this.buildStepResult("状态转换", from, to, false, `非法状态转换：${from} → ${to}`);
    }

    const guardResult = runTransitionGuards(from, to, session);
    if (!guardResult.passed) {
      return this.buildStepResult(
        "状态转换",
        from,
        to,
        false,
        `守卫检查失败：${guardResult.reason}`,
      );
    }

    // 记录步骤
    sessionStore.appendStep(
      buildStepRecord({ sessionId, from, to, operator, reason }, guardResult),
    );

    // 更新会话状态
    sessionStore.updateSession(sessionId, { state: to });

    return this.buildStepResult("状态转换", from, to, true, `${from} → ${to}：${reason}`);
  }

  /** 排空进行中操作（轮询直到 drained 或超时）。 */
  private async drainInFlight(sessionId: string): Promise<void> {
    const { writeFreeze, drainTimeoutMs = 300000, drainPollIntervalMs = 5000 } = this.options;
    const deadline = Date.now() + drainTimeoutMs;

    while (Date.now() < deadline) {
      const inFlight = await writeFreeze.probeInFlight();
      if (inFlight.drained) return;
      await new Promise((resolve) => setTimeout(resolve, drainPollIntervalMs));
    }

    throw new Error(`进行中操作排空超时（${drainTimeoutMs}ms）`);
  }

  /** 失败时触发回滚并返回结果。 */
  private async failWithRollback(
    session: CutoverSession,
    steps: OrchestratorStepResult[],
    precheckReport: PrecheckReport | null,
    failureReason: string,
  ): Promise<CutoverOrchestrationResult> {
    const { rollbackController, sessionStore } = this.options;
    const currentSession = sessionStore.getSession(session.id);
    if (!currentSession) {
      return {
        success: false,
        sessionId: session.id,
        finalState: "idle",
        steps,
        precheckReport,
        error: failureReason,
        rolledBack: false,
        rollbackError: "会话不存在，无法回滚",
      };
    }

    // 终态不回滚
    if (currentSession.state === "cutover_completed" || currentSession.state === "rolled_back") {
      return {
        success: false,
        sessionId: session.id,
        finalState: currentSession.state,
        steps,
        precheckReport,
        error: failureReason,
        rolledBack: false,
        rollbackError: null,
      };
    }

    try {
      const rollbackResult = await rollbackController.rollback(
        session.id,
        currentSession.initiatedBy,
        failureReason,
      );
      return {
        success: false,
        sessionId: session.id,
        finalState: rollbackResult.success ? "rolled_back" : currentSession.state,
        steps,
        precheckReport,
        error: failureReason,
        rolledBack: rollbackResult.success,
        rollbackError: rollbackResult.success ? null : rollbackResult.error,
      };
    } catch (err) {
      return {
        success: false,
        sessionId: session.id,
        finalState: currentSession.state,
        steps,
        precheckReport,
        error: failureReason,
        rolledBack: false,
        rollbackError: `回滚执行异常：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** 构造步骤结果。 */
  private buildStepResult(
    stepName: string,
    fromState: CutoverState,
    toState: CutoverState,
    success: boolean,
    details: string,
  ): OrchestratorStepResult {
    return {
      stepName,
      fromState,
      toState,
      success,
      details,
      timestamp: new Date().toISOString(),
    };
  }
}
