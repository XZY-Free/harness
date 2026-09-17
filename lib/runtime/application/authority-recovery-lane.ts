/**
 * Authority recovery lane（R01 §3 `Owner expired`；R04 §5 claim 规则）。
 *
 * 职责单一：发现「Current Owner 租约已到期」的 Invocation，并把**扫描时观察到的完整
 * Owner tuple** 交给 `markInvocationLost` 在根锁内复核后收口。
 *
 * 为什么必须是一条持久 lane 而不是请求内联处理：
 * 初始进程（Web / 单次请求栈）可能在任意提交点死亡，而"某个 Invocation 的 Owner 已经
 * 不可能再回来"这一事实只存在于数据库里。没有常驻发现者时，这些 Invocation 会永久停在
 * `queued/running/waiting_user`，占着 Thread 的 active Invocation 且没有任何收口路径。
 *
 * 语义边界（与 `evaluateStaleObservation` 严格一致，不是"杀掉一切租约到期的行"）：
 * - 租约确实到期且代际未变 → `lost`：Owner 关 `lost`、Session 关 `lost`、Invocation 收口、
 *   Turn 落 `failed`。
 * - 扫描与收口之间发生了续租 → 陈旧观察（`owner_renewed`），**不改任何状态**。
 * - 扫描与收口之间发生了换代 → 陈旧观察（`owner_replaced`），**新 Owner 不被触碰**。
 * - 扫描后 Invocation 已被别处收口 → 不再是本 lane 的工作，直接跳过。
 *
 * 单个 Invocation 的处理失败不阻断本轮其余候选：租约仍处于过期状态，下一轮会被再次扫到。
 */
import { logger } from "@/lib/logger";
import {
  findStaleInvocations,
  markInvocationLost,
} from "@/lib/runtime/application/runtime-recovery";
import { InvocationAlreadyTerminalError, InvocationNotFoundError } from "@/lib/runtime/errors";

/** 收口时写进 Owner/Invocation 的稳定原因码。 */
export const AUTHORITY_RECOVERY_REASON_CODE = "ownership_lease_expired";

export interface AuthorityRecoverySummary {
  scanned: number;
  recovered: number;
  /** 陈旧观察（续租/换代）与已被别处收口的候选，都只丢弃。 */
  discarded: number;
  failed: number;
}

export interface AuthorityRecoveryDeps {
  now?: Date;
}

/**
 * 单轮：按持久状态发现所有租约已到期的 Owner 并收口。
 *
 * 可被任意 Worker 在任意时刻重复调用：重复运行只会看到已经没有候选（收口后 Invocation
 * 不再是可恢复状态），因此天然幂等。
 */
export async function runDueExpiredOwnerRecoveries(input: {
  limit?: number;
  deps?: AuthorityRecoveryDeps;
}): Promise<AuthorityRecoverySummary> {
  const summary: AuthorityRecoverySummary = {
    scanned: 0,
    recovered: 0,
    discarded: 0,
    failed: 0,
  };
  const candidates = await findStaleInvocations({
    limit: input.limit ?? 50,
    ...(input.deps?.now ? { now: input.deps.now } : {}),
  });
  summary.scanned = candidates.length;

  for (const candidate of candidates) {
    try {
      const result = await markInvocationLost({
        tenantId: candidate.tenantId,
        invocationId: candidate.invocationId,
        reasonCode: AUTHORITY_RECOVERY_REASON_CODE,
        observedOwner: candidate.observedOwner,
      });
      if (result.outcome === "lost") summary.recovered += 1;
      else summary.discarded += 1;
    } catch (error) {
      // 扫描与收口之间被别处合法收口（或 Invocation 已不可见）：不是失败，丢弃即可。
      if (
        error instanceof InvocationAlreadyTerminalError ||
        error instanceof InvocationNotFoundError
      ) {
        summary.discarded += 1;
        continue;
      }
      summary.failed += 1;
      logger.error("[authority-recovery-lane] Owner 过期收口失败", {
        tenantId: candidate.tenantId,
        invocationId: candidate.invocationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
