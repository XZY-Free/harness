import { logger } from "@/lib/logger";
import { INVOCATION_TERMINAL_STATES } from "@/lib/persistence/schema/executions";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { markInvocationLost } from "@/lib/runtime/recovery-queries";
/**
 * A2A 背景流失败 Handler（06 §9）。
 *
 * Transport 只报告事实（06 §3）；本 handler 是外层 orchestration：
 * 复用现有 Recovery Authority（markInvocationLost / RuntimeSessionBinding.lost /
 * invocation.lost ThreadEvent），禁止新建 A2A 专用失败表或第二状态机（06 §2）。
 *
 * 事实源：docs/V12/01/SnowHarness_阶段1_代码收口详细方案_2026-08-26/06-A2AStream异常终态与Recovery.md。
 */
import type { A2ABackgroundFailureReport } from "@/lib/runtime/transport/a2a-transport";

/**
 * 幂等背景失败处理（06 §9 步骤 1-8）：
 * 1. reload Invocation；2. 已终态 → no-op；3. 正常 waiting_user → no-op；
 * 4-7. 其余调用正式 recovery（markInvocationLost 同事务写 lost 终态 +
 *    SessionBinding.lost + invocation.lost ThreadEvent）；
 * 8. 只记录 safe ids/failureKind。
 */
export async function handleA2ABackgroundFailure(params: {
  tenantId: string;
  report: A2ABackgroundFailureReport;
}): Promise<void> {
  const { report } = params;
  try {
    const invocation = await getInvocationById(params.tenantId, report.invocationId);
    if (!invocation) return;
    if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
      // 已终态（含此前背景失败已置 lost）→ 幂等 no-op。
      return;
    }
    if (invocation.executionState === "waiting_user") {
      // input-required 语义（06 §6）：EOF/流断对 waiting_user 正常，等用户 Resume。
      return;
    }
    await markInvocationLost({
      tenantId: params.tenantId,
      invocationId: report.invocationId,
      reasonCode: report.failureKind,
      errorSummary: `A2A stream 背景失败：${report.safeSummary}`,
      actorType: "system",
    });
    logger.warn("[runtime] A2A 背景流失败 → Invocation lost", {
      invocationId: report.invocationId,
      failureKind: report.failureKind,
    });
  } catch (err) {
    // 后台任务不向调度方抛出；只记录 safe ids/failureKind（06 §9.8）。
    logger.warn("[runtime] A2A 背景流失败处理异常", {
      invocationId: report.invocationId,
      failureKind: report.failureKind,
      error: String(err),
    });
  }
}
