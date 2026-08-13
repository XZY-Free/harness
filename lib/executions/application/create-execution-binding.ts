import {
  type ExecutionBinding,
  type ExecutionBindingConfigInput,
  computeExecutionBindingConfigHash,
} from "@/lib/executions/domain/execution-binding";
import type { ExecutionBindingStore } from "@/lib/executions/persistence/execution-binding-store";

export interface CreateExecutionBindingCommand extends ExecutionBindingConfigInput {
  invocationId: string;
  tenantId: string;
}

export function createCreateExecutionBinding(dependencies: {
  store: ExecutionBindingStore;
  now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());
  return async function createExecutionBinding(
    command: CreateExecutionBindingCommand,
  ): Promise<ExecutionBinding> {
    // : 统一事务 — 资格校验 + 行级锁 + Insert 全部在 Store.create() 单一事务内完成。
    // 不再在应用层独立调用 validateBindingEligibility()，避免双事务。
    const configHash = computeExecutionBindingConfigHash(command);
    return dependencies.store.create({
      ...command,
      configHash,
      boundAt: now(),
    });
  };
}
