import { createHash } from "node:crypto";
import type { RouteControlPlaneEvidence } from "@/lib/routes/domain/route-resolution-policy";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface ExecutionBindingControlPlaneEvidence extends RouteControlPlaneEvidence {
  routeRevisionId: string;
  routeActivationId: string;
  routeContentDigest: string;
  /** §07: Resolver 输入摘要 — 冻结解析时刻的请求参数 Digest。 */
  resolutionInputDigest: string;
}

export interface ExecutionBindingConfigInput {
  /** null = 基础 Harness Route（无 Agent 资产约束，§8.3）。 */
  agentRevisionId: string | null;
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
  initialEnvironmentLeaseId: string | null;
  workspaceBindingId: string | null;
  /**
   * 冻结的 Permission Policy Revision id（有效 Binding 永远非空，§10）。
   * Binding 时由 Route 显式指定；Route 未指定 → Tenant PolicySet("tool-execution").currentRevisionId。
   */
  policyRevisionId: string;
  /** 冻结的 Permission Policy rules digest（sha256: 前缀；必须与该 Revision rulesHash 一致，§9）。 */
  policyRulesDigest: string;
  /** 冻结的 Governance Config Revision id（NOT NULL，§11）。 */
  governanceConfigRevisionId: string;
  /** 冻结的 Governance Config digest（sha256: 前缀；必须与该 Revision configDigest 一致，§9）。 */
  governanceConfigDigest: string;
  contextCheckpointId: string | null;
  environmentDefinitionRevisionId: string | null;
  controlPlaneEvidence: ExecutionBindingControlPlaneEvidence;
  /** Projection 版本号 — Binding 用此检测 Projection 滞后。第三批新增。 */
  projectionVersionNo: number;
}

export interface ExecutionBinding
  extends Omit<ExecutionBindingConfigInput, "controlPlaneEvidence">,
    ExecutionBindingControlPlaneEvidence {
  invocationId: string;
  tenantId: string;
  configHash: string;
  boundAt: Date;
}

export class ExecutionBindingEvidenceError extends Error {
  constructor(message: string) {
    super(`ExecutionBinding 控制面证据无效：${message}`);
    this.name = "ExecutionBindingEvidenceError";
  }
}

export class ExecutionBindingAlreadyExistsError extends Error {
  constructor(invocationId: string) {
    super(`Invocation ${invocationId} 已存在 ExecutionBinding`);
    this.name = "ExecutionBindingAlreadyExistsError";
  }
}

export function computeExecutionBindingConfigHash(input: ExecutionBindingConfigInput): string {
  assertExecutionBindingEvidence(input.controlPlaneEvidence);
  assertExecutionBindingPolicyGovernance(input);
  if (!Number.isInteger(input.projectionVersionNo) || input.projectionVersionNo < 0) {
    throw new ExecutionBindingEvidenceError("projectionVersionNo 必须为非负整数");
  }
  const canonical = JSON.stringify(
    sortKeys({
      ...input,
      controlPlaneEvidence: {
        ...input.controlPlaneEvidence,
        // 基础 Harness Route 的 agentAttestationIds 为 null（§18 not_applicable），保持 null。
        agentAttestationIds: input.controlPlaneEvidence.agentAttestationIds
          ? [...input.controlPlaneEvidence.agentAttestationIds].sort()
          : null,
        runtimeAttestationIds: [...input.controlPlaneEvidence.runtimeAttestationIds].sort(),
      },
    }),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** §9：校验冻结的 Policy/Governance 四字段（有效 Binding 必须非空、digest 带 sha256: 前缀）。 */
export function assertExecutionBindingPolicyGovernance(input: ExecutionBindingConfigInput): void {
  if (!input.policyRevisionId) {
    throw new ExecutionBindingEvidenceError("有效 Binding 必须冻结 policyRevisionId（§10，非空）");
  }
  if (!input.governanceConfigRevisionId) {
    throw new ExecutionBindingEvidenceError(
      "有效 Binding 必须冻结 governanceConfigRevisionId（§11，非空）",
    );
  }
  if (!SHA256.test(input.policyRulesDigest)) {
    throw new ExecutionBindingEvidenceError("policyRulesDigest 格式非法");
  }
  if (!SHA256.test(input.governanceConfigDigest)) {
    throw new ExecutionBindingEvidenceError("governanceConfigDigest 格式非法");
  }
}

export function assertExecutionBindingEvidence(
  evidence: ExecutionBindingControlPlaneEvidence,
): void {
  // 基础 Harness Route：agent 字段全 null（Agent Evidence not_applicable，§18），
  // 跳过 Agent 维度校验（禁止伪装 passed、禁止空串假证据）；Runtime 维度始终校验。
  const isBaseRoute = evidence.agentArtifactId === null;

  const identifiers = [
    evidence.routeRevisionId,
    evidence.routeActivationId,
    evidence.runtimeArtifactId,
    evidence.runtimePublicationRecordId,
    evidence.conformanceRunId,
  ];
  if (identifiers.some((value) => !value)) {
    throw new ExecutionBindingEvidenceError("缺少 Route、Runtime Publication 或 Conformance 引用");
  }
  const digests = [
    evidence.routeContentDigest,
    evidence.runtimeArtifactDigest,
    evidence.runtimeConfigDigest,
    evidence.capabilityManifestDigest,
    evidence.resolutionInputDigest,
  ];
  if (digests.some((value) => !SHA256.test(value))) {
    throw new ExecutionBindingEvidenceError("Digest 格式非法");
  }
  if (!isBaseRoute) {
    if (!evidence.agentArtifactId || !evidence.agentPublicationRecordId) {
      throw new ExecutionBindingEvidenceError("缺少 Agent 引用");
    }
    if (!SHA256.test(evidence.agentArtifactDigest as string)) {
      throw new ExecutionBindingEvidenceError("Agent Artifact Digest 格式非法");
    }
    if (!validIds(evidence.agentAttestationIds as string[])) {
      throw new ExecutionBindingEvidenceError("Agent Attestation 引用不能为空或重复");
    }
  }
  if (!validIds(evidence.runtimeAttestationIds)) {
    throw new ExecutionBindingEvidenceError("Runtime Attestation 引用不能为空或重复");
  }
}

function validIds(values: string[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => Boolean(value)) &&
    new Set(values).size === values.length
  );
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}
