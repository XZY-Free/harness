/**
 * 稳定 Executions Schema — 正式控制面职责命名。
 */

export {
  v11ExecutionBinding as executionBindingTable,
  v11Invocation as invocationTable,
  /** @deprecated §9.3 — 只允许历史读取。正式写入使用 RuntimeConformanceRun + RuntimeConformanceCaseResult。 */
  v11RuntimeConformanceResult as runtimeConformanceResultTable,
} from "@/lib/v11/schema/runtime";
