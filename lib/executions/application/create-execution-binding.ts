import {
  type ExecutionBinding,
  type ExecutionBindingConfigInput,
  computeExecutionBindingConfigHash,
} from "@/lib/executions/domain/execution-binding";
import type { ExecutionBindingStore } from "@/lib/executions/persistence/execution-binding-store";
import { validateBindingEligibility } from "@/lib/executions/application/validate-binding-eligibility";

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
    // §5.1: 使用统一 validateBindingEligibility() 作为资格预检查。
    // Store.create() 事务内的行级锁校验作为最终一致性保证。
    const evidence = command.controlPlaneEvidence;
    const eligibility = await validateBindingEligibility({
      tenantId: command.tenantId,
      routeId: command.deploymentRouteId,
      routeRevisionId: evidence.routeRevisionId,
      routeActivationId: evidence.routeActivationId,
      agentRevisionId: command.agentRevisionId,
      runtimeRevisionId: command.runtimeRevisionId,
      policyRevisionId: command.policyRevisionId,
      projectionVersionNo: command.projectionVersionNo ?? 0,
    });
    if (!eligibility.valid) {
      throw new Error(`Binding 资格校验失败: ${eligibility.reason}`);
    }

    const configHash = computeExecutionBindingConfigHash(command);
    return dependencies.store.create({
      ...command,
      configHash,
      boundAt: now(),
    });
  };
}
