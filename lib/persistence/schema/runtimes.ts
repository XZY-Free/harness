/**
 * 稳定 Runtime Schema — 正式控制面职责命名。
 */

export {
  RUNTIME_KINDS,
  RUNTIME_LIFECYCLE_STATES,
  RUNTIME_REVISION_STATES,
  v11Runtime as runtimeTable,
  v11RuntimeRevision as runtimeRevisionTable,
} from "@/lib/v11/schema/runtime";

export type {
  RuntimeKind,
  RuntimeLifecycleState,
  RuntimeRevisionState,
  V11Runtime as RuntimeRow,
  V11RuntimeRevision as RuntimeRevisionRow,
  NewV11Runtime as NewRuntimeRow,
  NewV11RuntimeRevision as NewRuntimeRevisionRow,
} from "@/lib/v11/schema/runtime";
