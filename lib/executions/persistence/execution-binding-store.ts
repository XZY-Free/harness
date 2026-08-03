import type {
  ExecutionBinding,
  ExecutionBindingConfigInput,
} from "@/lib/executions/domain/execution-binding";

export interface StoreExecutionBindingInput extends ExecutionBindingConfigInput {
  invocationId: string;
  tenantId: string;
  configHash: string;
  boundAt: Date;
}

export interface ExecutionBindingStore {
  create(input: StoreExecutionBindingInput): Promise<ExecutionBinding>;
}
