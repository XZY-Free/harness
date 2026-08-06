/**
 * 稳定 Runtime Schema — 正式控制面职责命名。
 */

export {
 RUNTIME_KINDS,
 RUNTIME_LIFECYCLE_STATES,
 RUNTIME_REVISION_STATES,
 runtimeTable,
 runtimeRevisionTable,
} from "@/lib/persistence/schema/runtime";

export type {
 RuntimeKind,
 RuntimeLifecycleState,
 RuntimeRevisionState,
 Runtime as RuntimeRow,
 RuntimeRevision as RuntimeRevisionRow,
 NewRuntime as NewRuntimeRow,
 NewRuntimeRevision as NewRuntimeRevisionRow,
} from "@/lib/persistence/schema/runtime";
