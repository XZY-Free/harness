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
    const configHash = computeExecutionBindingConfigHash(command);
    return dependencies.store.create({
      ...command,
      configHash,
      boundAt: now(),
    });
  };
}
