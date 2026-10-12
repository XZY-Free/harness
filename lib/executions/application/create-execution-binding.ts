import {
  type ContextSummaryStore,
  resolveInitialCompression,
  toInitialContextCompression,
} from "@/lib/context/initial-checkpoint-source";
import {
  type ExecutionBinding,
  type ExecutionBindingConfigInput,
  computeExecutionBindingConfigHash,
} from "@/lib/executions/domain/execution-binding";
import type { ExecutionBindingStore } from "@/lib/executions/persistence/execution-binding-store";

export interface CreateExecutionBindingCommand
  extends Omit<ExecutionBindingConfigInput, "initialContextCompression"> {
  invocationId: string;
  tenantId: string;
  /**
   * T33：可选的初始压缩材料引用（null/缺省 = 本次不选择）。
   *
   * 调用方只给引用；存在性/tenant/用途/Hash/有效期/访问权限由本服务核验后
   * 派生「已验证描述」写进 configHash，调用方不能自报摘要。
   */
  initialContextCheckpointId?: string | null;
}

export function createCreateExecutionBinding(dependencies: {
  store: ExecutionBindingStore;
  now?: () => Date;
  /** T33：初始压缩材料的受管摘要读取端口（未配置时 ref-only Checkpoint 会被拒绝）。 */
  summaryStore?: ContextSummaryStore | null;
}) {
  const now = dependencies.now ?? (() => new Date());
  return async function createExecutionBinding(
    command: CreateExecutionBindingCommand,
  ): Promise<ExecutionBinding> {
    const { initialContextCheckpointId, ...config } = command;
    // T33：初始压缩材料必须先真实读取并核验（存在性/tenant/用途/Hash/有效期/访问权限），
    // 「只要有 ID 就绑定」被禁止。configHash 覆盖该引用与稳定摘要，因而
    // ContextHandle.bindingDigest 引用的是同一个已验证值。
    const verifiedInitialCompression = initialContextCheckpointId
      ? toInitialContextCompression(
          await resolveInitialCompression({
            tenantId: command.tenantId,
            checkpointId: initialContextCheckpointId,
            requester: { type: command.principalType, id: command.principalId },
            now: now(),
            summaryStore: dependencies.summaryStore ?? null,
          }),
        )
      : null;
    // : 统一事务 — 资格校验 + 行级锁 + Insert 全部在 Store.create() 单一事务内完成。
    // 不再在应用层独立调用 validateBindingEligibility()，避免双事务。
    const configHash = computeExecutionBindingConfigHash({
      ...config,
      initialContextCompression: verifiedInitialCompression,
    });
    return dependencies.store.create({
      ...config,
      initialContextCompression: verifiedInitialCompression,
      configHash,
      boundAt: now(),
    });
  };
}
