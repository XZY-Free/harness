/**
 * V11 稳定错误码投影。
 *
 * 事实源是 `docs/solutions/v11-agentkit-platform/contracts/error-codes.json`（normative）。
 * 本模块是运行时投影，避免把 docs 目录耦合进运行时 bundle（tsconfig 已 exclude docs）。
 * `error-codes.test.ts` 校验本投影与契约 JSON 完全一致；契约变更时测试失败，强制同步。
 *
 * S01-W02 契约变更规则：
 * - 移除错误码 = major，必须提升 contract_version。
 * - 改变 retryable 语义 = major。
 * - HTTP 映射集以契约为准（400/401/403/404/409/412/413/422/429/503）。
 */
export interface V11ErrorDefinition {
  /** HTTP 状态码，与 error-codes.json 的 http 字段一致。 */
  readonly http: number;
  /** 是否允许客户端按 retry_after/退避重试。 */
  readonly retryable: boolean;
}

export const V11_ERROR_CODES = {
  ACCESS_DENIED: { http: 403, retryable: false },
  ACTION_SCOPE_DENIED: { http: 403, retryable: false },
  ACTIVE_LEGAL_HOLD: { http: 409, retryable: false },
  AGENT_CAPABILITY_UNSUPPORTED: { http: 422, retryable: false },
  ARTIFACT_ATTESTATION_FAILED: { http: 422, retryable: false },
  ARTIFACT_ATTESTATION_REVOKED: { http: 409, retryable: false },
  ARTIFACT_BINDING_MISMATCH: { http: 409, retryable: false },
  ARTIFACT_NOT_VERIFIED: { http: 409, retryable: false },
  ATTESTATION_ALREADY_REVOKED: { http: 409, retryable: false },
  AUTHENTICATION_REQUIRED: { http: 401, retryable: false },
  BUSINESS_CONSTRAINT_VIOLATION: { http: 422, retryable: false },
  CAPABILITY_CONTENT_BLOCKED: { http: 422, retryable: false },
  CAPABILITY_NOT_ALLOWED: { http: 404, retryable: false },
  CATALOG_REVISION_INVALID: { http: 400, retryable: false },
  CHILD_BUDGET_EXCEEDED: { http: 422, retryable: false },
  CHILD_BUDGET_EXHAUSTED: { http: 422, retryable: false },
  CHILD_CONTEXT_NOT_ALLOWED: { http: 403, retryable: false },
  CHILD_THREAD_ALREADY_TERMINAL: { http: 409, retryable: false },
  CONTEXT_CHECKPOINT_TOO_LARGE: { http: 413, retryable: false },
  CONTEXT_SOURCE_HASH_MISMATCH: { http: 409, retryable: true },
  DELEGATION_DEPTH_EXCEEDED: { http: 422, retryable: false },
  DELEGATION_NOT_ALLOWED: { http: 403, retryable: false },
  DELETION_STEP_FAILED: { http: 503, retryable: true },
  ENVIRONMENT_CHANGE_NOT_SAFE: { http: 422, retryable: false },
  ETAG_MISMATCH: { http: 412, retryable: true },
  EGRESS_BLOCKED: { http: 422, retryable: false },
  EVENT_CURSOR_EXPIRED: { http: 409, retryable: false },
  EVENT_QUARANTINE_RESOLUTION_NOT_ALLOWED: { http: 422, retryable: false },
  EVENT_SCHEMA_UNSUPPORTED: { http: 422, retryable: false },
  EVENT_SEQUENCE_GAP: { http: 409, retryable: true },
  EXECUTION_OWNERSHIP_CHANGED: { http: 409, retryable: false },
  IDEMPOTENCY_CONFLICT: { http: 409, retryable: false },
  JOB_ALREADY_TERMINAL: { http: 409, retryable: false },
  JOB_INPUT_NO_LONGER_AVAILABLE: { http: 422, retryable: false },
  JOB_USER_ACTION_NOT_ALLOWED: { http: 409, retryable: false },
  JOB_NOT_TERMINAL: { http: 409, retryable: false },
  JOB_OVERRIDE_NOT_ALLOWED: { http: 422, retryable: false },
  JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT: { http: 409, retryable: false },
  MEMORY_CANDIDATE_ALREADY_RESOLVED: { http: 409, retryable: false },
  MEMORY_CONTENT_HASH_MISMATCH: { http: 409, retryable: false },
  MEMORY_SCOPE_NOT_ALLOWED: { http: 403, retryable: false },
  MEMORY_SENSITIVE_CONTENT: { http: 422, retryable: false },
  MEMORY_SOURCE_NOT_ALLOWED: { http: 403, retryable: false },
  OPERATION_PAYLOAD_CONFLICT: { http: 409, retryable: false },
  PARENT_INVOCATION_NOT_ACTIVE: { http: 409, retryable: false },
  POLICY_BLOCKED: { http: 403, retryable: false },
  RATE_LIMITED: { http: 429, retryable: true },
  REQUEST_SCHEMA_INVALID: { http: 400, retryable: false },
  RESOURCE_NOT_FOUND: { http: 404, retryable: false },
  RUNTIME_UNAVAILABLE: { http: 503, retryable: true },
  FEATURE_NOT_READY: { http: 503, retryable: true },
  SHARED_BUDGET_EXHAUSTED: { http: 422, retryable: false },
  STREAM_BACKPRESSURE: { http: 429, retryable: true },
  TOOL_SCHEMA_CHANGED: { http: 409, retryable: true },
  TURN_REQUIRES_USER_ACTION: { http: 409, retryable: false },
  TURN_ALREADY_TERMINAL: { http: 409, retryable: false },
  WORKSPACE_OVERLAY_MERGE_CONFLICT: { http: 409, retryable: false },
  WORKSPACE_OVERLAY_STATE_CONFLICT: { http: 409, retryable: false },
  WORKSPACE_WRITE_LOCK_CONFLICT: { http: 409, retryable: false },
  WORKSPACE_WRITE_LOCK_STATE_CONFLICT: { http: 409, retryable: false },
  WORKLOAD_TOKEN_REVOKED: { http: 401, retryable: false },
  // ─── RouteSet 聚合激活（任务 1.5/1.6）──────────────────
  ROUTE_WEIGHT_TOTAL_INVALID: { http: 422, retryable: false },
  ROUTE_GROUP_SELECTOR_MISMATCH: { http: 422, retryable: false },
  ROUTE_SELECTOR_AMBIGUOUS: { http: 422, retryable: false },
  ROUTE_SET_REQUIRES_ATOMIC_UPDATE: { http: 409, retryable: false },
  ROUTE_REVISION_NOT_ELIGIBLE: { http: 422, retryable: false },
  ROUTE_SET_VERSION_CONFLICT: { http: 412, retryable: false },
  /** §2.4: Route 执行资格不足。 */
  ROUTE_EXECUTION_INELIGIBLE: { http: 422, retryable: false },
  /** §2.1: Eligibility 条件格式非法。 */
  ROUTE_ELIGIBILITY_INVALID: { http: 422, retryable: false },
  /** §3.6: 控制面事件类型不支持或 Payload 不合法。 */
  CONTROL_PLANE_EVENT_UNSUPPORTED: { http: 422, retryable: false },
  /** §3.2: 事件合同验证失败。 */
  CONTROL_PLANE_EVENT_CONTRACT_VIOLATION: { http: 422, retryable: false },
} as const satisfies Readonly<Record<string, V11ErrorDefinition>>;

export type V11ErrorCode = keyof typeof V11_ERROR_CODES;

/** 查询错误码定义；未知码抛错（fail-closed，禁止运行时凭空调用）。 */
export function errorDefinition(code: string): V11ErrorDefinition {
  const def = V11_ERROR_CODES[code as V11ErrorCode];
  if (!def) {
    throw new Error(`unknown V11 error code: ${code}`);
  }
  return def;
}
