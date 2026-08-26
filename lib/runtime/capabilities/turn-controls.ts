import { db } from "@/lib/db/client";
import type { Turn } from "@/lib/persistence/schema/conversation";
/**
 * Turn Controls 投影（05 §9）。
 *
 * Turn DTO 的 controls（cancel_supported/resume_supported/steer_supported）
 * 必须由服务端按精确 Binding 派生（EffectiveInvocationCapabilities），
 * 客户端不得自行从 Agent Selector 卡片猜测；终态 Turn 恒 false。
 *
 * 事实源：docs/V12/01/SnowHarness_阶段1_代码收口详细方案_2026-08-26/05-Cancel能力贯通.md §9。
 */
import { executionBindingTable } from "@/lib/persistence/schema/executions";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import { and, eq, inArray } from "drizzle-orm";

/** Turn DTO controls（snake_case 投影）。 */
export interface TurnControls {
  readonly cancel_supported: boolean;
  readonly resume_supported: boolean;
  readonly steer_supported: boolean;
}

/** 终态 Turn：controls 全 false（05 §9）。 */
const TERMINAL_TURN_CONTROLS: TurnControls = {
  cancel_supported: false,
  resume_supported: false,
  steer_supported: false,
};

const TERMINAL_TURN_STATES = new Set(["completed", "interrupted", "failed", "cancelled"]);

/** 当前 Invocation（active 优先，回退 latest）。 */
function currentInvocationId(turn: Turn): string | null {
  return turn.activeInvocationId ?? turn.latestInvocationId;
}

/**
 * 批量解析 Turn controls：Turn → 当前 Invocation → Binding → effective capabilities。
 * 无 Invocation/Binding（尚未 dispatch 或 Base 之外的特殊态）→ fail-closed 全 false。
 */
export async function resolveTurnControls(
  tenantId: string,
  turns: readonly Turn[],
): Promise<Map<string, TurnControls>> {
  const result = new Map<string, TurnControls>();
  // 收集需要解析 Binding 的非终态 Turn Invocation。
  const pending = new Map<string, { turnIds: string[]; bindingId: string }>();
  for (const turn of turns) {
    if (TERMINAL_TURN_STATES.has(turn.turnState)) {
      result.set(turn.id, TERMINAL_TURN_CONTROLS);
      continue;
    }
    const invocationId = currentInvocationId(turn);
    if (!invocationId) {
      result.set(turn.id, TERMINAL_TURN_CONTROLS);
      continue;
    }
    pending.set(invocationId, {
      turnIds: [...(pending.get(invocationId)?.turnIds ?? []), turn.id],
      bindingId: invocationId,
    });
  }
  if (pending.size === 0) return result;

  const invocationIds = [...pending.keys()];
  const bindingRows = await db
    .select({
      invocationId: executionBindingTable.invocationId,
      agentContractSnapshotId: executionBindingTable.agentContractSnapshotId,
      runtimeRevisionId: executionBindingTable.runtimeRevisionId,
    })
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, tenantId),
        inArray(executionBindingTable.invocationId, invocationIds),
      ),
    );
  const bindingByInvocation = new Map(bindingRows.map((row) => [row.invocationId, row]));

  for (const [invocationId, entry] of pending) {
    const binding = bindingByInvocation.get(invocationId);
    let controls: TurnControls = TERMINAL_TURN_CONTROLS;
    if (binding) {
      // 租户过滤：Binding 表含 tenantId，跨租户行视为不存在（fail-closed）。
      const capabilities = await resolveEffectiveInvocationCapabilities({
        tenantId,
        binding: {
          agentContractSnapshotId: binding.agentContractSnapshotId,
          runtimeRevisionId: binding.runtimeRevisionId,
        },
      });
      controls = {
        cancel_supported: capabilities.cancel,
        resume_supported: capabilities.resume,
        steer_supported: capabilities.steer,
      };
    }
    for (const turnId of entry.turnIds) {
      result.set(turnId, controls);
    }
  }
  return result;
}
