/**
 * S13-W04 回滚控制器：失败时恢复旧入口，隔离 V11 新写入。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W04、§回滚边界
 *         （冻结或切换失败时恢复旧入口，V11 新写入不得与旧事实源同时对员工开放；
 *           回滚只允许在旧写入口仍冻结且 V11 新事实可以完整隔离或回放的观察窗口内执行；
 *           已完成外部副作用、已发消息、已改文件和已写业务系统的数据不能由版本回滚撤销；
 *           回滚先停止新 Invocation，核对 ToolCall/Effect、Job 和 Desktop ownership，再恢复旧入口；
 *           超出回滚窗口后使用 V11 的修复、补偿和新版本发布，不重新启用长期双轨）。
 *
 * 设计：
 * - 回滚条件检查：仅允许在切换窗口内（write_frozen ~ cutover_ready）回滚，cutover_completed 后不允许。
 * - 回滚步骤：停止新 Invocation → 核对进行中操作 → 隔离 V11 写入 → 解冻旧入口 → 记录回滚原因。
 * - 回滚记录：失败原因、回滚操作人、回滚时间、是否成功。
 * - 回滚完成后会话进入 rolled_back 终态，V11 入口保持隔离。
 */
import type { CutoverSessionStore } from "@/lib/v11/cutover/session-store";
import type { CutoverState } from "@/lib/v11/cutover/state-machine";
import type { WriteFreezeController } from "@/lib/v11/cutover/write-freeze";

// ─── 回滚条件检查 ──────────────────────────────────────────

/** 允许回滚的状态集合（切换窗口内）。 */
const ROLLBACK_ALLOWED_STATES: ReadonlySet<CutoverState> = new Set([
  "precheck",
  "backup_ready",
  "write_frozen",
  "drained",
  "incremental_migration",
  "cutover_ready",
]);

/** 检查当前状态是否允许回滚。 */
export function isRollbackAllowed(state: CutoverState): boolean {
  return ROLLBACK_ALLOWED_STATES.has(state);
}

// ─── 回滚结果 ──────────────────────────────────────────────

/** 回滚结果。 */
export interface RollbackResult {
  /** 是否成功。 */
  readonly success: boolean;
  /** 会话 ID。 */
  readonly sessionId: string;
  /** 回滚前状态。 */
  readonly fromState: CutoverState;
  /** 回滚操作人。 */
  readonly operator: string;
  /** 失败原因（触发回滚的原因）。 */
  readonly failureReason: string;
  /** 回滚步骤记录。 */
  readonly steps: readonly RollbackStep[];
  /** 错误信息（回滚失败时填充）。 */
  readonly error: string | null;
  /** 回滚时间戳（ISO 字符串）。 */
  readonly timestamp: string;
}

/** 单个回滚步骤。 */
export interface RollbackStep {
  readonly name: string;
  readonly success: boolean;
  readonly details: string;
  readonly timestamp: string;
}

// ─── 回滚错误 ──────────────────────────────────────────────

/** 回滚错误（不允许回滚的状态或回滚步骤失败）。 */
export class RollbackError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly currentState: CutoverState,
  ) {
    super(message);
    this.name = "RollbackError";
  }
}

// ─── 回滚控制器 ──────────────────────────────────────────

/** 回滚控制器选项。 */
export interface RollbackControllerOptions {
  /** 会话存储。 */
  readonly sessionStore: CutoverSessionStore;
  /** 写入冻结控制器。 */
  readonly writeFreeze: WriteFreezeController;
  /**
   * V11 写入隔离器（回滚时停止 V11 新写入）。
   * 生产由 Gateway / Runtime 提供；测试可注入 mock。
   */
  readonly v11Isolator: V11Isolator;
}

/** V11 写入隔离器接口（回滚时调用）。 */
export interface V11Isolator {
  /** 停止 V11 新 Invocation（隔离 V11 写入）。 */
  stopNewInvocations(sessionId: string): Promise<void>;
  /** 隔离 V11 新写入（关闭 V11 入口对员工的可见性）。 */
  isolateV11Writes(sessionId: string): Promise<void>;
  /** 核对 V11 已写入数据是否已隔离。 */
  verifyIsolated(sessionId: string): Promise<boolean>;
}

/** 回滚控制器。 */
export class RollbackController {
  constructor(private readonly options: RollbackControllerOptions) {}

  /**
   * 执行回滚。
   * @param sessionId 会话 ID
   * @param operator 回滚操作人
   * @param failureReason 触发回滚的失败原因
   */
  async rollback(
    sessionId: string,
    operator: string,
    failureReason: string,
  ): Promise<RollbackResult> {
    const { sessionStore, writeFreeze, v11Isolator } = this.options;
    const session = sessionStore.getSession(sessionId);
    if (!session) {
      throw new RollbackError(`切换会话不存在：${sessionId}`, sessionId, "idle");
    }

    const timestamp = new Date().toISOString();
    const steps: RollbackStep[] = [];

    // 步骤 0：检查回滚条件
    if (!isRollbackAllowed(session.state)) {
      const err = new RollbackError(
        `当前状态 ${session.state} 不允许回滚（仅切换窗口内可回滚，cutover_completed 后不可回滚）`,
        sessionId,
        session.state,
      );
      return {
        success: false,
        sessionId,
        fromState: session.state,
        operator,
        failureReason,
        steps: [
          {
            name: "回滚条件检查",
            success: false,
            details: err.message,
            timestamp,
          },
        ],
        error: err.message,
        timestamp,
      };
    }

    // 步骤 1：停止 V11 新 Invocation
    try {
      await v11Isolator.stopNewInvocations(sessionId);
      steps.push({
        name: "停止 V11 新 Invocation",
        success: true,
        details: "已停止 V11 新 Invocation",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = `停止 V11 新 Invocation 失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push({
        name: "停止 V11 新 Invocation",
        success: false,
        details: msg,
        timestamp: new Date().toISOString(),
      });
      // 致命错误：无法停止 V11 写入，回滚失败
      sessionStore.updateSession(sessionId, {
        state: session.state, // 保持原状态
        failureReason: `回滚失败：${msg}`,
      });
      return {
        success: false,
        sessionId,
        fromState: session.state,
        operator,
        failureReason,
        steps,
        error: msg,
        timestamp,
      };
    }

    // 步骤 2：隔离 V11 新写入
    try {
      await v11Isolator.isolateV11Writes(sessionId);
      steps.push({
        name: "隔离 V11 新写入",
        success: true,
        details: "已隔离 V11 新写入",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = `隔离 V11 新写入失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push({
        name: "隔离 V11 新写入",
        success: false,
        details: msg,
        timestamp: new Date().toISOString(),
      });
      sessionStore.updateSession(sessionId, {
        state: session.state,
        failureReason: `回滚失败：${msg}`,
      });
      return {
        success: false,
        sessionId,
        fromState: session.state,
        operator,
        failureReason,
        steps,
        error: msg,
        timestamp,
      };
    }

    // 步骤 3：验证 V11 已隔离
    try {
      const isolated = await v11Isolator.verifyIsolated(sessionId);
      if (!isolated) {
        const msg = "V11 写入隔离验证失败，仍有未隔离的写入";
        steps.push({
          name: "验证 V11 已隔离",
          success: false,
          details: msg,
          timestamp: new Date().toISOString(),
        });
        sessionStore.updateSession(sessionId, {
          state: session.state,
          failureReason: `回滚失败：${msg}`,
        });
        return {
          success: false,
          sessionId,
          fromState: session.state,
          operator,
          failureReason,
          steps,
          error: msg,
          timestamp,
        };
      }
      steps.push({
        name: "验证 V11 已隔离",
        success: true,
        details: "V11 写入已完全隔离",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = `验证 V11 隔离执行失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push({
        name: "验证 V11 已隔离",
        success: false,
        details: msg,
        timestamp: new Date().toISOString(),
      });
      sessionStore.updateSession(sessionId, {
        state: session.state,
        failureReason: `回滚失败：${msg}`,
      });
      return {
        success: false,
        sessionId,
        fromState: session.state,
        operator,
        failureReason,
        steps,
        error: msg,
        timestamp,
      };
    }

    // 步骤 4：解冻旧入口（恢复旧写入）
    try {
      await writeFreeze.unfreezeAll(operator, `回滚恢复旧入口：${failureReason}`);
      steps.push({
        name: "解冻旧写入口",
        success: true,
        details: "已解冻全部旧写入口",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = `解冻旧写入口失败：${err instanceof Error ? err.message : String(err)}`;
      steps.push({
        name: "解冻旧写入口",
        success: false,
        details: msg,
        timestamp: new Date().toISOString(),
      });
      sessionStore.updateSession(sessionId, {
        state: session.state,
        failureReason: `回滚失败：${msg}`,
      });
      return {
        success: false,
        sessionId,
        fromState: session.state,
        operator,
        failureReason,
        steps,
        error: msg,
        timestamp,
      };
    }

    // 步骤 5：更新会话状态为 rolled_back
    sessionStore.updateSession(sessionId, {
      state: "rolled_back",
      failureReason,
      completedAt: new Date().toISOString(),
    });

    return {
      success: true,
      sessionId,
      fromState: session.state,
      operator,
      failureReason,
      steps,
      error: null,
      timestamp: new Date().toISOString(),
    };
  }
}
