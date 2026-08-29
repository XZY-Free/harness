import { createHash } from "node:crypto";

export const MAX_ROUTE_TRAFFIC_WEIGHT = 10_000;

export interface RouteRevisionContent {
  /**
   * 绑定的 AgentRevision ID。
   *
   * null = 基础 Harness Runtime Route，不附加 Agent 资产约束（§12）。
   * 有值 = 带 Agent 控制面约束的 Route，需完整 Agent Evidence 资格判断。
   * 与 runtimeRevisionId 一起参与 content digest 规范化（§7.5）。
   */
  agentRevisionId: string | null;
  runtimeRevisionId: string;

  // ─── Agent Route 生产调用事实（专题01 Batch4 补漏，02 §12.2/12.3）────────
  // Agent Route（agentRevisionId 非空）必须冻结 endpoint/identity/credential/network
  // 事实；基础 Harness Route（runtime）为 null。这些 exact route facts 由 RouteResolver
  // 在解析 agent target 时返回，Batch7 创建 AgentCallBinding 时直接冻结（不另设第二套
  // endpoint authority）。参与 content digest。
  /** Agent 能力 endpoint 引用（URL 或 managed endpoint 引用）。 */
  agentEndpointRef?: string | null;
  /** Agent 出站身份模式（none/bearer）。 */
  agentIdentityMode?: "none" | "bearer" | null;
  /** 按 identityMode 条件要求；bearer 必填，none 可为 null。 */
  agentCredentialRefId?: string | null;
  /** Agent 网络区域。 */
  agentNetworkZone?: string | null;

  policyRevisionId: string | null;
  modelPolicyRevisionId: string | null;
  toolsetRevisionId: string | null;
  trafficWeight: number;
  priorityNo: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  eligibilityConditions: Record<string, unknown>;
  /** Route Group 标识 — 同 Group 成员必须相同 eligibilityConditions、priorityNo、specificity、effectiveFrom、effectiveUntil。 */
  routeGroupId: string;
}

export class RouteWeightInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteWeightInvalidError";
  }
}

export class RouteEffectiveWindowInvalidError extends Error {
  constructor() {
    super("RouteRevision effectiveFrom 必须早于 effectiveUntil");
    this.name = "RouteEffectiveWindowInvalidError";
  }
}

export class RouteSetNotFoundError extends Error {
  constructor(public readonly routeSetId: string) {
    super(`RouteSet 不存在或跨租户不可见: ${routeSetId}`);
    this.name = "RouteSetNotFoundError";
  }
}

export class RouteNotFoundError extends Error {
  constructor(public readonly routeId: string) {
    super(`DeploymentRoute 不存在或跨租户不可见: ${routeId}`);
    this.name = "RouteNotFoundError";
  }
}

export class RouteSetVersionConflictError extends Error {
  constructor(
    public readonly routeSetId: string,
    public readonly expectedVersionNo: number,
    public readonly actualVersionNo: number,
  ) {
    super(`RouteSet 版本冲突（期望 ${expectedVersionNo}, 实际 ${actualVersionNo}）: ${routeSetId}`);
    this.name = "RouteSetVersionConflictError";
  }
}

export class RevisionNotPublishedError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly revisionType: "agent" | "runtime",
    public readonly actualState: string,
  ) {
    super(
      `${revisionType === "agent" ? "AgentRevision" : "RuntimeRevision"} ${revisionId} 状态为 ${actualState}，不是 published`,
    );
    this.name = "RevisionNotPublishedError";
  }
}

export class ArtifactNotVerifiedForRouteError extends Error {
  constructor(
    public readonly revisionId: string,
    public readonly artifactType: "agent_revision" | "runtime_revision",
  ) {
    super(`Revision ${revisionId} 的 ${artifactType} attestation 未 verified`);
    this.name = "ArtifactNotVerifiedForRouteError";
  }
}

export class RouteIdempotencyCompletionError extends Error {
  constructor(public readonly recordId: string) {
    super(`RouteActivation 幂等记录完成失败: ${recordId}`);
    this.name = "RouteIdempotencyCompletionError";
  }
}

/**
 * Eligibility 条件格式非法（非标量值、NaN、Infinity 等）。
 * normalizeEligibility 返回 null 时抛出。
 */
export class RouteEligibilityInvalidError extends Error {
  constructor(
    public readonly routeId: string,
    public readonly invalidConditions: unknown,
  ) {
    super(`Route ${routeId} eligibilityConditions 格式非法，normalizeEligibility 返回 null`);
    this.name = "RouteEligibilityInvalidError";
  }
}

/**
 * Route 执行资格不足 — 使用完整 RevisionExecutionEligibilityPolicy 判定。
 */
export class RouteExecutionIneligibleError extends Error {
  constructor(
    public readonly routeId: string,
    public readonly errors: Array<{ dimension: string; code: string; message: string }>,
  ) {
    super(
      `Route ${routeId} 执行资格不足: ${errors.map((e) => `${e.dimension}(${e.code})`).join(", ")}`,
    );
    this.name = "RouteExecutionIneligibleError";
  }
}

export function validateRouteRevisionContent(content: RouteRevisionContent): void {
  if (
    !Number.isInteger(content.trafficWeight) ||
    content.trafficWeight < 0 ||
    content.trafficWeight > MAX_ROUTE_TRAFFIC_WEIGHT
  ) {
    throw new RouteWeightInvalidError(
      `trafficWeight ${content.trafficWeight} 超出 0–${MAX_ROUTE_TRAFFIC_WEIGHT} 范围`,
    );
  }
  if (
    !Number.isInteger(content.priorityNo) ||
    (content.effectiveFrom &&
      content.effectiveUntil &&
      content.effectiveFrom >= content.effectiveUntil)
  ) {
    if (!Number.isInteger(content.priorityNo)) {
      throw new RouteWeightInvalidError("priorityNo 必须为整数");
    }
    throw new RouteEffectiveWindowInvalidError();
  }
  // Agent Route 必须冻结生产调用事实；基础 Harness Route 不得携带。
  const endpointRef = content.agentEndpointRef ?? null;
  const identityMode = content.agentIdentityMode ?? null;
  const credentialRefId = content.agentCredentialRefId ?? null;
  const networkZone = content.agentNetworkZone ?? null;
  if (content.agentRevisionId !== null) {
    if (!endpointRef) {
      throw new RouteAgentEndpointFactsError("agent route 必须冻结 agentEndpointRef");
    }
    if (identityMode !== "none" && identityMode !== "bearer") {
      throw new RouteAgentEndpointFactsError("agent route 必须冻结合法 agentIdentityMode");
    }
    if (identityMode === "bearer" && !credentialRefId) {
      throw new RouteAgentEndpointFactsError("bearer agent route 必须冻结 agentCredentialRefId");
    }
    if (!networkZone) {
      throw new RouteAgentEndpointFactsError("agent route 必须冻结 agentNetworkZone");
    }
  } else {
    if (endpointRef !== null || identityMode !== null || credentialRefId !== null || networkZone !== null) {
      throw new RouteAgentEndpointFactsError("基础 Harness Route 不得携带 Agent endpoint 事实");
    }
  }
}

export class RouteAgentEndpointFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteAgentEndpointFactsError";
  }
}

export function computeRouteRevisionContentDigest(content: RouteRevisionContent): string {
  const canonical = canonicalize({
    agent_revision_id: content.agentRevisionId,
    // Agent Route 生产调用事实（02 §12.3：Route digest 必须包括 target 全部 target-specific 字段）。
    agent_endpoint_ref: content.agentEndpointRef ?? null,
    agent_identity_mode: content.agentIdentityMode ?? null,
    agent_credential_ref_id: content.agentCredentialRefId ?? null,
    agent_network_zone: content.agentNetworkZone ?? null,
    runtime_revision_id: content.runtimeRevisionId,
    policy_revision_id: content.policyRevisionId,
    model_policy_revision_id: content.modelPolicyRevisionId,
    toolset_revision_id: content.toolsetRevisionId,
    traffic_allocation: { weight_basis_points: content.trafficWeight },
    route_group_id: content.routeGroupId,
    priority_no: content.priorityNo,
    effective_from: content.effectiveFrom?.toISOString() ?? null,
    effective_until: content.effectiveUntil?.toISOString() ?? null,
    eligibility_conditions: content.eligibilityConditions,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
}
