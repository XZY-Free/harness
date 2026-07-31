/**
 * S13-W04 写入冻结控制器：冻结/解冻旧写入口，查询进行中操作。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W04
 *         （先冻结旧写入口并等待进行中的 Invocation/ToolCall/Effect 到安全点，再执行最后增量迁移；
 *           冻结或切换失败时恢复旧入口，V11 新写入不得与旧事实源同时对员工开放）。
 *
 * 设计：
 * - 抽象接口 WriteFreezeController，支持多种入口点（API Gateway、Runtime Event Ingress、Job 调度）。
 * - InMemoryWriteFreezeController：内存实现，用于测试与开发。
 * - 冻结状态记录：冻结时间、操作人、原因、关联会话 ID。
 * - 进行中操作查询（drain check）：返回进行中 Invocation/ToolCall/Effect 数量。
 * - 冻结期间所有旧写入请求被拒绝（返回 WriteFrozenError）。
 */
import type { CutoverSession } from "@/lib/v11/cutover/session-store";

// ─── 冻结入口点 ──────────────────────────────────────────────

/** 旧写入口点类型。 */
export type WriteEntryPoint =
  | "employee_api" // 员工端 API（旧）
  | "admin_api" // 管理后台 API（旧）
  | "runtime_event_ingress" // Runtime Event Ingress（旧）
  | "job_scheduler" // 后台 Job 调度（旧）
  | "tool_call_ingress" // ToolCall 外部回调（旧）
  | "sse_subscription"; // SSE 订阅写回（旧）

/** 全部旧写入口点。 */
export const ALL_WRITE_ENTRY_POINTS: readonly WriteEntryPoint[] = [
  "employee_api",
  "admin_api",
  "runtime_event_ingress",
  "job_scheduler",
  "tool_call_ingress",
  "sse_subscription",
];

// ─── 冻结状态 ──────────────────────────────────────────────

/** 单个入口点的冻结状态。 */
export interface EntryFreezeStatus {
  readonly entryPoint: WriteEntryPoint;
  readonly frozen: boolean;
  readonly frozenAt: string | null;
  readonly frozenBy: string | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
}

/** 进行中操作统计（drain 检查用）。 */
export interface InFlightOperations {
  /** 进行中的 Invocation 数量。 */
  readonly invocations: number;
  /** 进行中的 ToolCall 数量。 */
  readonly toolCalls: number;
  /** 进行中的 Effect 数量。 */
  readonly effects: number;
  /** 进行中的 Job 数量。 */
  readonly jobs: number;
  /** 是否已到安全点（所有计数为 0）。 */
  readonly drained: boolean;
}

// ─── 冻结错误 ──────────────────────────────────────────────

/** 写入被冻结错误（旧入口冻结期间尝试写入时抛出）。 */
export class WriteFrozenError extends Error {
  constructor(
    readonly entryPoint: WriteEntryPoint,
    readonly sessionId: string | null,
  ) {
    super(`写入入口 ${entryPoint} 已冻结（会话：${sessionId ?? "未知"}），切换窗口内禁止旧写入`);
    this.name = "WriteFrozenError";
  }
}

// ─── 写入冻结控制器接口 ──────────────────────────────────

/** 进行中操作探测函数（生产由 Runtime/Job 调度器实现）。 */
export type InFlightProbe = () => InFlightOperations | Promise<InFlightOperations>;

/** 写入冻结控制器接口。 */
export interface WriteFreezeController {
  /** 冻结指定入口点。 */
  freeze(
    entryPoint: WriteEntryPoint,
    session: CutoverSession,
    operator: string,
    reason: string,
  ): Promise<void>;

  /** 批量冻结所有入口点。 */
  freezeAll(session: CutoverSession, operator: string, reason: string): Promise<void>;

  /** 解冻指定入口点（回滚用）。 */
  unfreeze(entryPoint: WriteEntryPoint, operator: string, reason: string): Promise<void>;

  /** 批量解冻所有入口点（回滚用）。 */
  unfreezeAll(operator: string, reason: string): Promise<void>;

  /** 查询某入口点的冻结状态。 */
  getStatus(entryPoint: WriteEntryPoint): EntryFreezeStatus;

  /** 查询所有入口点的冻结状态。 */
  getAllStatuses(): readonly EntryFreezeStatus[];

  /** 检查是否全部入口点已冻结。 */
  isAllFrozen(): boolean;

  /** 检查是否全部入口点已解冻。 */
  isAllUnfrozen(): boolean;

  /** 断言入口点未冻结（写入时调用，冻结则抛 WriteFrozenError）。 */
  assertNotFrozen(entryPoint: WriteEntryPoint): void;

  /** 查询进行中操作（drain 检查）。 */
  probeInFlight(): Promise<InFlightOperations>;

  /** 注册进行中操作探测函数。 */
  registerInFlightProbe(probe: InFlightProbe): void;
}

// ─── 内存写入冻结控制器 ──────────────────────────────────

/** 内存写入冻结控制器（测试和开发用）。 */
export class InMemoryWriteFreezeController implements WriteFreezeController {
  private readonly statuses = new Map<WriteEntryPoint, EntryFreezeStatus>();
  private inFlightProbe: InFlightProbe | null = null;

  constructor() {
    for (const ep of ALL_WRITE_ENTRY_POINTS) {
      this.statuses.set(ep, {
        entryPoint: ep,
        frozen: false,
        frozenAt: null,
        frozenBy: null,
        reason: null,
        sessionId: null,
      });
    }
  }

  async freeze(
    entryPoint: WriteEntryPoint,
    session: CutoverSession,
    operator: string,
    reason: string,
  ): Promise<void> {
    const existing = this.statuses.get(entryPoint);
    if (existing?.frozen) {
      throw new Error(`入口点 ${entryPoint} 已冻结，无法重复冻结`);
    }
    this.statuses.set(entryPoint, {
      entryPoint,
      frozen: true,
      frozenAt: new Date().toISOString(),
      frozenBy: operator,
      reason,
      sessionId: session.id,
    });
  }

  async freezeAll(session: CutoverSession, operator: string, reason: string): Promise<void> {
    for (const ep of ALL_WRITE_ENTRY_POINTS) {
      const existing = this.statuses.get(ep);
      if (!existing?.frozen) {
        this.statuses.set(ep, {
          entryPoint: ep,
          frozen: true,
          frozenAt: new Date().toISOString(),
          frozenBy: operator,
          reason,
          sessionId: session.id,
        });
      }
    }
  }

  async unfreeze(entryPoint: WriteEntryPoint, operator: string, reason: string): Promise<void> {
    const existing = this.statuses.get(entryPoint);
    if (!existing?.frozen) {
      // 已解冻，幂等返回
      return;
    }
    this.statuses.set(entryPoint, {
      entryPoint,
      frozen: false,
      frozenAt: null,
      frozenBy: null,
      reason: `已由 ${operator} 解冻：${reason}`,
      sessionId: null,
    });
  }

  async unfreezeAll(operator: string, reason: string): Promise<void> {
    for (const ep of ALL_WRITE_ENTRY_POINTS) {
      await this.unfreeze(ep, operator, reason);
    }
  }

  getStatus(entryPoint: WriteEntryPoint): EntryFreezeStatus {
    return (
      this.statuses.get(entryPoint) ?? {
        entryPoint,
        frozen: false,
        frozenAt: null,
        frozenBy: null,
        reason: null,
        sessionId: null,
      }
    );
  }

  getAllStatuses(): readonly EntryFreezeStatus[] {
    return ALL_WRITE_ENTRY_POINTS.map((ep) => this.getStatus(ep));
  }

  isAllFrozen(): boolean {
    return ALL_WRITE_ENTRY_POINTS.every((ep) => this.statuses.get(ep)?.frozen === true);
  }

  isAllUnfrozen(): boolean {
    return ALL_WRITE_ENTRY_POINTS.every((ep) => this.statuses.get(ep)?.frozen === false);
  }

  assertNotFrozen(entryPoint: WriteEntryPoint): void {
    const status = this.statuses.get(entryPoint);
    if (status?.frozen) {
      throw new WriteFrozenError(entryPoint, status.sessionId);
    }
  }

  async probeInFlight(): Promise<InFlightOperations> {
    if (this.inFlightProbe) {
      return await this.inFlightProbe();
    }
    // 默认无探测函数时返回已排空
    return {
      invocations: 0,
      toolCalls: 0,
      effects: 0,
      jobs: 0,
      drained: true,
    };
  }

  registerInFlightProbe(probe: InFlightProbe): void {
    this.inFlightProbe = probe;
  }
}
