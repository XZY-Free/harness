/**
 * V11 可验证删除执行器（S12-W07）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-data-lifecycle.md §7
 *         （删除执行器按计划调用各存储 Adapter；部分失败保持 failed/partial 并可安全重试；
 *           completed 要求所有 in-scope step 有存储端 evidenceRef；
 *           不以"主表已删"宣称全部完成，不写 ThreadEvent 冒充已删除）。
 *
 * 职责：
 * - executeDeletionRequest：入口。查询请求 → 转移到 deleting → 执行 runnable steps → 派生终态。
 * - 每步执行：markStepRunning → Adapter.delete → completeDeletionStep(evidenceRef) /
 *   markStepRetained（共享资源保留）/ failDeletionStep（可重试或不可重试）。
 * - 幂等：已完成/保留/跳过/阻塞的 step 不重复执行（markStepRunning 内部判定）。
 * - 终态派生：所有 step 执行完后调 deriveTerminalStateFromSteps → updateDeletionRequestState。
 *   - 全 completed/retained/skipped → completed
 *   - 含 failed 且无 blocked/pending/running → partial（可重试）
 *   - 含 blocked/pending/running → 保持 deleting（不自动终态）
 *
 * 错误映射（由 route 层负责 HTTP 投影）：
 * - DeletionStoreError retryable=true → step failed，请求保持 deleting/partial（可重试）
 * - DeletionStoreError retryable=false → step failed，请求保持 partial（不可重试的 step 留 failed）
 * - 请求状态非法（已终态）→ DeletionExecutorError illegal_state_for_execution（route 映射 409）
 *
 * 不变量：
 * - Legal Hold 阻止在 planner 阶段处理（executor 不重复检查）。
 * - completed 要求所有 in-scope DeletionStep 含 evidenceRef（completeDeletionStep 强制）。
 * - 不写 ThreadEvent 冒充已删除，只写管理域 AuditEvent（updateDeletionRequestState 内部）。
 */
import type { AuditActor } from "@/lib/v11/identity/audit";
import {
  type DeletionRequestSummary,
  completeDeletionStep,
  computeRequestSummary,
  deriveTerminalStateFromSteps,
  failDeletionStep,
  getDeletionRequestById,
  listDeletionSteps,
  listRunnableSteps,
  markStepRetained,
  markStepRunning,
  updateDeletionRequestState,
} from "@/lib/v11/identity/deletion-request-queries";
import { DeletionStoreError } from "@/lib/v11/identity/deletion-store-adapter";
import { getDeletionStoreAdapter } from "@/lib/v11/identity/deletion-store-config";
import type {
  DeletionRequestState,
  V11DeletionRequest,
  V11DeletionStep,
} from "@/lib/v11/schema/deletion-request";

// ─── 错误类型 ──────────────────────────────────────────────

/** 删除执行器错误。 */
export class DeletionExecutorError extends Error {
  constructor(
    public readonly code: "request_not_found" | "illegal_state_for_execution" | "no_steps_planned",
    message: string,
  ) {
    super(message);
    this.name = "DeletionExecutorError";
  }
}

// ─── 可执行状态集合 ────────────────────────────────────────

/**
 * 可被 executor 推进的请求状态。
 * - planning：首次执行（planner 已生成 steps）。
 * - blocked_by_hold：Hold 解除后重试（重新规划后执行）。
 * - partial：部分失败重试（重新执行 failed steps）。
 * - deleting：上次执行中断（继续执行未完成 steps）。
 *
 * 终态（completed/failed/cancelled）不可执行，抛 illegal_state_for_execution。
 */
const EXECUTABLE_REQUEST_STATES: ReadonlySet<DeletionRequestState> = new Set([
  "planning",
  "blocked_by_hold",
  "partial",
  "deleting",
]);

// ─── 执行结果 ──────────────────────────────────────────────

/** executor 执行结果（供 route 构建响应 + 测试断言）。 */
export interface DeletionExecutionResult {
  /** 最终请求行（含状态机推进后的 state）。 */
  request: V11DeletionRequest;
  /** 全部 steps（按 storeType, subjectRef 排序）。 */
  steps: V11DeletionStep[];
  /** 请求汇总（从 steps 派生）。 */
  summary: DeletionRequestSummary;
  /** 本次执行的 step 数（不含幂等跳过的 completed/retained/skipped/blocked）。 */
  executedSteps: number;
  /** 本次失败的 step 数（含可重试与不可重试）。 */
  failedSteps: number;
  /** 是否含不可重试失败（影响终态：保留 partial 不转 completed）。 */
  hasNonRetryableFailure: boolean;
  /** 派生的终态（null 表示未派生，保持 deleting）。 */
  derivedTerminalState: DeletionRequestState | null;
}

// ─── 执行入口 ──────────────────────────────────────────────

/**
 * 执行删除请求：按计划调用各存储 Adapter，派生终态。
 *
 * 流程：
 * 1. 查询请求；不存在抛 request_not_found。
 * 2. 校验状态可执行（planning/blocked_by_hold/partial/deleting）；终态抛 illegal_state_for_execution。
 * 3. 非 deleting 状态先转移到 deleting（写审计 before/after）。
 * 4. 查询 runnable steps（pending + failed 可重试）。
 * 5. 对每个 step：
 *    - markStepRunning（幂等：pending/failed → running + attemptCount+1；其他状态原样返回，跳过）。
 *    - 调用 DeletionStoreAdapter.delete：
 *      - success + retained=true → markStepRetained（共享资源保留）。
 *      - success + retained=false → completeDeletionStep(evidenceRef)（强制非空 evidenceRef）。
 *      - DeletionStoreError → failDeletionStep（写 failureReason；retryable=false 时标记不可重试）。
 * 6. 查询全部 steps，派生终态（deriveTerminalStateFromSteps）。
 * 7. 派生到终态时转移状态机（deleting → completed/partial）；未派生保持 deleting。
 *
 * 幂等：completed/retained/skipped/blocked 的 step 不重复执行（markStepRunning 跳过）。
 * 重试：partial 状态再次调用时，failed steps 重新执行（attemptCount+1）。
 *
 * @throws DeletionExecutorError request_not_found / illegal_state_for_execution / no_steps_planned
 * @throws DeletionRequestError 状态机非法转移（由 updateDeletionRequestState 抛出）
 */
export async function executeDeletionRequest(params: {
  tenantId: string;
  /** 删除请求 id（V11DeletionRequest.id）。 */
  deletionRequestId: string;
  actor: AuditActor;
  /** HTTP X-Request-ID，用于审计关联（可选）。 */
  requestId?: string;
}): Promise<DeletionExecutionResult> {
  const { tenantId, deletionRequestId, actor, requestId } = params;

  // 1. 查询请求
  let request = await getDeletionRequestById(tenantId, deletionRequestId);
  if (!request) {
    throw new DeletionExecutorError(
      "request_not_found",
      `删除请求不存在（id=${deletionRequestId}）`,
    );
  }

  // 2. 校验状态可执行
  if (!EXECUTABLE_REQUEST_STATES.has(request.requestState)) {
    throw new DeletionExecutorError(
      "illegal_state_for_execution",
      `删除请求状态不可执行（state=${request.requestState}，id=${deletionRequestId}）`,
    );
  }

  // 3. 非 deleting 状态先转移到 deleting（写审计 before/after）
  if (request.requestState !== "deleting") {
    request = await updateDeletionRequestState({
      tenantId,
      id: deletionRequestId,
      nextState: "deleting",
      actor,
      reason: `执行器启动：${request.requestState} → deleting`,
      requestId,
    });
  }

  // 4. 查询 runnable steps（pending + failed 可重试）
  const runnableSteps = await listRunnableSteps(tenantId, deletionRequestId);

  // 5. 逐个执行（顺序执行，避免并发冲突；存储 Adapter 内部可并行优化但不在此层）
  let executedCount = 0;
  let failedCount = 0;
  let hasNonRetryable = false;

  for (const step of runnableSteps) {
    // markStepRunning 幂等：pending/failed → running + attemptCount+1；
    // 其他状态（completed/retained/skipped/blocked/running）原样返回，跳过执行。
    const runningStep = await markStepRunning({
      tenantId,
      stepId: step.id,
    });

    if (runningStep.stepState !== "running") {
      // 已完成/保留/跳过/阻塞的 step 不重复执行（幂等）
      continue;
    }

    executedCount += 1;

    // 调用存储 Adapter（fail-closed：未注入的 Adapter 抛 DeletionStoreError retryable=true）
    const adapter = getDeletionStoreAdapter(step.storeType);
    try {
      const result = await adapter.delete({
        tenantId,
        subjectType: request.subjectType,
        subjectRef: step.subjectRef,
        requestId,
      });

      if (result.retained) {
        // 共享资源保留（不删除，记录原因）
        await markStepRetained({
          tenantId,
          stepId: step.id,
          reason: result.retainReason ?? "共享资源保留",
        });
      } else {
        // 完成步骤（completeDeletionStep 强制非空 evidenceRef）
        await completeDeletionStep({
          tenantId,
          stepId: step.id,
          evidenceRef: result.evidenceRef,
        });
      }
    } catch (err) {
      failedCount += 1;
      const isRetryable = err instanceof DeletionStoreError ? err.retryable : true;
      if (!isRetryable) {
        hasNonRetryable = true;
      }
      const failureReason = err instanceof Error ? err.message : String(err);
      await failDeletionStep({
        tenantId,
        stepId: step.id,
        failureReason,
      });
    }
  }

  // 6. 查询全部 steps，派生终态
  const allSteps = await listDeletionSteps(tenantId, deletionRequestId);
  if (allSteps.length === 0) {
    // 防御性检查：executor 被调用时 planner 应已生成 steps。
    // 空 steps 通常意味着 route 在 blocked 时错误地调用了 executor。
    throw new DeletionExecutorError(
      "no_steps_planned",
      `删除请求无规划步骤（id=${deletionRequestId}）：executor 应在 planner 生成 steps 后调用`,
    );
  }
  const summary = computeRequestSummary(allSteps);
  const derivedTerminalState = deriveTerminalStateFromSteps(allSteps);

  // 7. 派生到终态时转移状态机（deleting → completed/partial）
  //    - 全 completed/retained/skipped → completed
  //    - 含 failed 且无 blocked/pending/running → partial（可重试）
  //    - 含 blocked/pending/running → 保持 deleting（不自动终态）
  if (derivedTerminalState !== null) {
    request = await updateDeletionRequestState({
      tenantId,
      id: deletionRequestId,
      nextState: derivedTerminalState,
      actor,
      reason: `执行器完成：deleting → ${derivedTerminalState}`,
      requestId,
    });
  }

  return {
    request,
    steps: allSteps,
    summary,
    executedSteps: executedCount,
    failedSteps: failedCount,
    hasNonRetryableFailure: hasNonRetryable,
    derivedTerminalState,
  };
}

// ─── 重试入口（便捷封装） ──────────────────────────────────

/**
 * 重试部分失败的删除请求（partial → deleting → 重新执行 failed steps）。
 *
 * 与 executeDeletionRequest 等价，仅语义化入口：调用方显式表达"重试"意图。
 * 内部走相同流程：partial → deleting → listRunnableSteps（含 failed）→ 执行 → 派生终态。
 *
 * @throws DeletionExecutorError 请求不存在或非 partial/deleting 状态
 */
export async function retryDeletionRequest(params: {
  tenantId: string;
  /** 删除请求 id（V11DeletionRequest.id）。 */
  deletionRequestId: string;
  actor: AuditActor;
  /** HTTP X-Request-ID，用于审计关联（可选）。 */
  requestId?: string;
}): Promise<DeletionExecutionResult> {
  const { tenantId, deletionRequestId } = params;
  const request = await getDeletionRequestById(tenantId, deletionRequestId);
  if (!request) {
    throw new DeletionExecutorError(
      "request_not_found",
      `删除请求不存在（id=${deletionRequestId}）`,
    );
  }
  if (request.requestState !== "partial" && request.requestState !== "deleting") {
    throw new DeletionExecutorError(
      "illegal_state_for_execution",
      `重试仅允许 partial/deleting 状态（当前 state=${request.requestState}，id=${deletionRequestId}）`,
    );
  }
  return executeDeletionRequest(params);
}
