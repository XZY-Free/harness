import { createHash } from "node:crypto";
import type { RouteControlPlaneEvidence } from "@/lib/routes/domain/route-resolution-policy";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface ExecutionBindingControlPlaneEvidence
  extends Omit<
    RouteControlPlaneEvidence,
    | "agentRevisionId"
    | "agentContractSnapshotId"
    | "agentContractDigest"
    | "agentContextDigest"
    | "agentPublicationRecordId"
  > {
  routeRevisionId: string;
  routeActivationId: string;
  routeContentDigest: string;
  /** Resolver 输入摘要 — 冻结解析时刻的请求参数 Digest。 */
  resolutionInputDigest: string;
}

export interface ExecutionBindingConfigInput {
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
  // 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，不再携带任何 Agent evidence。
  // Runtime evidence all-or-nothing（03 §3）：hosted 要求 artifact 全集；
  // external_endpoint 无 Runtime Artifact（不伪造），attestation 集合为空。
  const isExternalRuntime = evidence.runtimeEvidenceKind === "external_endpoint";
  const identifiers = [
    evidence.routeRevisionId,
    evidence.routeActivationId,
    evidence.runtimePublicationRecordId,
    evidence.conformanceRunId,
  ];
  if (identifiers.some((value) => !value)) {
    throw new ExecutionBindingEvidenceError("缺少 Route、Runtime Publication 或 Conformance 引用");
  }
  if (!isExternalRuntime && !evidence.runtimeArtifactId) {
    throw new ExecutionBindingEvidenceError("hosted_artifact 证据缺少 Runtime Artifact 引用");
  }
  const digests = [
    evidence.routeContentDigest,
    evidence.runtimeConfigDigest,
    evidence.capabilityManifestDigest,
    evidence.resolutionInputDigest,
  ];
  if (digests.some((value) => !SHA256.test(value))) {
    throw new ExecutionBindingEvidenceError("Digest 格式非法");
  }
  if (!isExternalRuntime && !SHA256.test(evidence.runtimeArtifactDigest as string)) {
    throw new ExecutionBindingEvidenceError("Runtime Artifact Digest 格式非法");
  }
  if (isExternalRuntime) {
    if (evidence.runtimeAttestationIds.length > 0) {
      throw new ExecutionBindingEvidenceError(
        "external_endpoint 证据不允许携带 Runtime Artifact Attestation（不得伪造 Runtime Artifact）",
      );
    }
  } else if (!validIds(evidence.runtimeAttestationIds)) {
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
