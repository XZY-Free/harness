/**
 * 稳定 Executions Schema — 正式控制面职责命名。
 */

export {
  executionBindingTable,
  invocationTable,
} from "@/lib/persistence/schema/runtime";

export type {
  ExecutionBinding as ExecutionBindingRow,
  NewExecutionBinding as NewExecutionBindingRow,
  Invocation as InvocationRow,
  NewInvocation as NewInvocationRow,
} from "@/lib/persistence/schema/runtime";
