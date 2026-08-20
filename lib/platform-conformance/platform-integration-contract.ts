/**
 * Platform Integration Conformance 合同唯一入口。
 *
 * 职责：SnowHarness 正式控制面与执行面组合以后，是否满足平台级不变量。本层属于
 * CI / Platform Release Gate，不属于 RuntimeRevision Publication Gate，不写入
 * RuntimeConformanceRun、不阻断 RuntimeRevision Publication。
 *
 * 平台 case 需要 Route、Projection、ExecutionBinding、Invocation、Attempt、
 * Event Ingress、Tool Gateway、Memory、Child Thread、ExecutionOwnership 等完整
 * 平台对象才能真正证明，因此运行顺序必须在 Runtime Publication Conformance PASS →
 * RuntimeRevision published → Route → Projection → Resolver → ExecutionBinding →
 * Invocation/Attempt → Runtime 之后。
 *
 * 事实源：docs/contracts/platform-integration-conformance.json（1.0.0）。
 */

/** Platform Integration 套件修订号。 */
export const PLATFORM_INTEGRATION_SUITE_REVISION = "platform-integration@1";

/** Platform Integration 的唯一 Case 全集（平台级不变量，不阻断 Publication）。 */
export const PLATFORM_INTEGRATION_CASES = [
  "dispatch-binds-immutable-config",
  "event-batch-idempotent",
  "event-payload-hash-conflict",
  "attempt-sequence-continuity",
  "steer-requires-ack",
  "unsupported-steer",
  "cancel-request-not-terminal",
  "tool-schema-refresh",
  "unknown-effect-no-replay",
  "capability-search-not-use",
  "memory-proposal-only",
  "child-thread-isolation",
  "child-cancel-requires-ack",
  "credential-never-in-model-data",
  "execution-ownership-epoch",
] as const;

export type PlatformIntegrationCaseId = (typeof PLATFORM_INTEGRATION_CASES)[number];

export interface PlatformIntegrationCaseResult {
  caseId: PlatformIntegrationCaseId;
  passed: boolean;
  reason?: string;
}

export interface PlatformIntegrationRun {
  tenantId: string;
  runtimeRevisionId: string;
  suiteRevision: typeof PLATFORM_INTEGRATION_SUITE_REVISION;
  caseResults: PlatformIntegrationCaseResult[];
}
