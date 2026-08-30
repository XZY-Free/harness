import { createHash } from "node:crypto";

export const MAX_ROUTE_TRAFFIC_WEIGHT = 10_000;

/**
 * Route content target — 严格判别联合（Agent 与 Runtime Authority 分离）。
 *
 * - runtime：顶层执行目标，只携带 RuntimeRevision 事实。
 * - agent：Harness 调用 Agent 能力，只携带 exact Agent 生产调用事实
 *   （endpoint/identity/credential/network， 补漏 /12.3）。
 *
 * 禁止 flat 字段或别名。target 之外的字段为公共 route 字段。
 */
export type RouteRevisionTarget =
  | { kind: "runtime"; runtimeRevisionId: string }
  | {
      kind: "agent";
      agentRevisionId: string;
      /** Agent 能力 endpoint 引用（URL 或 managed endpoint 引用）。 */
      agentEndpointRef: string;
      /** Agent 出站身份模式。 */
      agentIdentityMode: "none" | "bearer";
      /** 按 identityMode 条件要求；bearer 必填，none 可为 null。 */
      agentCredentialRefId: string | null;
      /** Agent 网络区域。 */
      agentNetworkZone: string;
    };

export interface RouteRevisionContent {
  /** 判别 target — 只含所选 target 自己的事实。 */
  target: RouteRevisionTarget;

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

/** Route target 冻结事实非法（空/空白/缺失/混合 target）。 */
export class RouteAgentEndpointFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteAgentEndpointFactsError";
  }
}

const AGENT_TARGET_FACT_KEYS = [
  "agentRevisionId",
  "agentEndpointRef",
  "agentIdentityMode",
  "agentCredentialRefId",
  "agentNetworkZone",
] as const;

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** 校验 target 对象不得以 own property 形式携带对侧 target 的任一 key（即便值为 null/undefined）。 */
function hasOwnKey(candidate: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(candidate, key);
}

function hasAnyOwnKey(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => hasOwnKey(candidate, key));
}

/**
 * 校验 target 判别联合，fail-closed 于任何畸形/混合/空 target。
 *
 * 输入可能经调用方 cast 为 unknown/any 注入非法字段，故在此防御式校验：
 * - runtime target 不得携带 Agent 事实；agent target 不得携带 runtimeRevisionId。
 * - 所有标识符/事实必须是非空字符串（空/空白非法）。
 * - bearer 必须冻结 credentialRefId；none 允许 credentialRefId 为 null。
 */
export function validateRouteRevisionTarget(target: RouteRevisionTarget): void {
  if (typeof target !== "object" || target === null) {
    throw new RouteAgentEndpointFactsError("Route content target 必须为对象");
  }
  const candidate = target as Record<string, unknown>;
  if (candidate.kind === "runtime") {
    if (!hasNonEmptyString(candidate.runtimeRevisionId)) {
      throw new RouteAgentEndpointFactsError("runtime target 必须冻结非空 runtimeRevisionId");
    }
    // runtime target 不得以 own property 形式携带 Agent target 任一 key
    // （即便值为 null/undefined 的旧占位也不可静默接受）。
    if (hasAnyOwnKey(candidate, AGENT_TARGET_FACT_KEYS)) {
      throw new RouteAgentEndpointFactsError("runtime target 不得携带 Agent target 事实");
    }
    return;
  }
  if (candidate.kind === "agent") {
    // 拒绝经 cast 注入的旧式/混合 runtimeRevisionId own property（即便 null/undefined）—
    // 不得静默忽略。
    if (hasOwnKey(candidate, "runtimeRevisionId")) {
      throw new RouteAgentEndpointFactsError("agent target 不得携带 runtimeRevisionId");
    }
    for (const key of ["agentRevisionId", "agentEndpointRef", "agentNetworkZone"] as const) {
      if (!hasNonEmptyString(candidate[key])) {
        throw new RouteAgentEndpointFactsError(`agent target 必须冻结非空 ${key}`);
      }
    }
    if (candidate.agentIdentityMode !== "none" && candidate.agentIdentityMode !== "bearer") {
      throw new RouteAgentEndpointFactsError("agent target 必须冻结合法 agentIdentityMode");
    }
    if (candidate.agentIdentityMode === "bearer") {
      if (!hasNonEmptyString(candidate.agentCredentialRefId)) {
        throw new RouteAgentEndpointFactsError("bearer agent target 必须冻结 agentCredentialRefId");
      }
    } else if (
      candidate.agentCredentialRefId !== null &&
      !hasNonEmptyString(candidate.agentCredentialRefId)
    ) {
      throw new RouteAgentEndpointFactsError(
        "agentCredentialRefId 必须为非空字符串或 null（none 模式）",
      );
    }
    return;
  }
  throw new RouteAgentEndpointFactsError(
    `未知 Route content target kind: ${String(candidate.kind)}`,
  );
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
  validateRouteRevisionTarget(content.target);
}

export function computeRouteRevisionContentDigest(content: RouteRevisionContent): string {
  // fail-closed：畸形/混合 target 一律拒绝，不得静默忽略。
  validateRouteRevisionContent(content);
  const canonical = canonicalize({
    // 只包含所选 target 自己的事实。
    target: normalizeTargetForDigest(content.target),
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

/** 将判别 target 归一为 digest 规范形 — 只含所选 target 自己的事实。 */
function normalizeTargetForDigest(target: RouteRevisionTarget): unknown {
  if (target.kind === "runtime") {
    return { kind: "runtime", runtime_revision_id: target.runtimeRevisionId };
  }
  return {
    kind: "agent",
    agent_revision_id: target.agentRevisionId,
    agent_endpoint_ref: target.agentEndpointRef,
    agent_identity_mode: target.agentIdentityMode,
    agent_credential_ref_id: target.agentCredentialRefId,
    agent_network_zone: target.agentNetworkZone,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
}
