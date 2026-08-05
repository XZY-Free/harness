/**
 * 稳定 Executions Schema — 正式控制面职责命名。
 */

export {
  v11ExecutionBinding as executionBindingTable,
  v11Invocation as invocationTable,
} from "@/lib/v11/schema/runtime";

export type {
  V11ExecutionBinding as ExecutionBindingRow,
  NewV11ExecutionBinding as NewExecutionBindingRow,
  V11Invocation as InvocationRow,
  NewV11Invocation as NewInvocationRow,
} from "@/lib/v11/schema/runtime";
