import { createHash } from "node:crypto";
import type { RouteEvidence } from "@/lib/routes/domain/route-resolution-policy";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * ExecutionBinding 控制面证据 — 只绑定 Harness Runtime。
 *
 * 从 RouteEvidence 的 runtime 变体派生，明确去掉判别 kind 包装（Binding 存储层扁平化）。
 * 不含任何 Agent evidence 字段；Agent 调用由 AgentCallBinding 单独负责。
 */
export type ExecutionBindingRuntimeEvidence = Omit<
  Extract<RouteEvidence, { kind: "runtime" }>,
  "kind"
>;

export interface ExecutionBindingControlPlaneEvidence extends ExecutionBindingRuntimeEvidence {
  routeRevisionId: string;
  routeActivationId: string;
  routeContentDigest: string;
  /** Resolver 输入摘要 — 冻结解析时刻的请求参数 Digest。 */
  resolutionInputDigest: string;
}

/**
 * 冻结的初始压缩材料描述（T33）。
 *
 * 三字段都是「已验证事实」，不由调用方自报：
 * - checkpointId：同 tenant 的 ContextCheckpoint.id（用途必须是 compression）；
 * - summaryHash：该 Checkpoint 摘要正文的 sha256（已与正文核对一致）；
 * - sourceRangesHash：该 Checkpoint 来源范围的 sha256（已与 sourceRangesJson 核对一致）。
 *
 * 本描述进入 configHash，因而 ContextHandle.bindingDigest 与 Start.executionBinding
 * 引用的是同一个已验证值。
 */
export interface InitialContextCompression {
  checkpointId: string;
  summaryHash: string;
  sourceRangesHash: string;
}

export interface ExecutionBindingConfigInput {
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
  workspaceBindingId: string;
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
  environmentDefinitionRevisionId: string | null;
  environmentMode: "MANAGED" | "NO_PLATFORM_ENVIRONMENT";
  capabilityCatalogJson: unknown;
  capabilityCatalogDigest: string;
  capabilityCatalogVersion: string;
  capabilityCatalogSourceRefs: string[];
  capabilityCatalogCreatedAt: Date;
  controlPlaneEvidence: ExecutionBindingControlPlaneEvidence;
  /** Projection 版本号 — Binding 用此检测 Projection 滞后。第三批新增。 */
  projectionVersionNo: number;
  principalType: "user" | "service";
  principalId: string;
  principalSource: "authenticated_user" | "trusted_service";
  principalFrozenAt: Date;
  /**
   * T33：初始压缩材料（null = 未选择）。可选字段，缺省等价于 null。
   *
   * 由 Binding 创建链路在验证 Checkpoint 存在性/tenant/用途/摘要/来源/有效期/访问权限
   * 之后填入「已验证描述」；调用方不能只给 id 就绑定。
   */
  initialContextCompression?: InitialContextCompression | null;
}

export interface ExecutionBinding
  extends Omit<ExecutionBindingConfigInput, "controlPlaneEvidence">,
    ExecutionBindingControlPlaneEvidence {
  invocationId: string;
  tenantId: string;
  configHash: string;
  /**
   * T33 回读形态：只携带冻结引用列（null = 未选择）。
   *
   * summaryHash/sourceRangesHash 已进入 `configHash`，由 `lib/context/initial-checkpoint-source.ts`
   * 在每次 ContextHandle 发放与使用时重新核验，因此回读对象不重复携带一份可漂移的摘要。
   */
  initialContextCheckpointId: string | null;
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
  if (
    !input.capabilityCatalogJson ||
    !SHA256.test(input.capabilityCatalogDigest) ||
    !input.capabilityCatalogVersion ||
    !Array.isArray(input.capabilityCatalogSourceRefs) ||
    !(input.capabilityCatalogCreatedAt instanceof Date) ||
    Number.isNaN(input.capabilityCatalogCreatedAt.getTime())
  ) {
    throw new ExecutionBindingEvidenceError("能力目录冻结字段不完整");
  }
  if (
    !input.principalId ||
    (input.principalType === "user" && input.principalSource !== "authenticated_user") ||
    (input.principalType === "service" && input.principalSource !== "trusted_service") ||
    !(input.principalFrozenAt instanceof Date) ||
    Number.isNaN(input.principalFrozenAt.getTime())
  ) {
    throw new ExecutionBindingEvidenceError("可信 principal 冻结字段不完整或不一致");
  }
  assertInitialContextCompression(input.initialContextCompression ?? null);
  const canonical = JSON.stringify(
    sortKeys({
      ...input,
      // undefined 与 null 必须收敛为同一个值，否则「未选择」会出现两种不同 digest。
      initialContextCompression: normalizeInitialContextCompression(
        input.initialContextCompression ?? null,
      ),
      controlPlaneEvidence: {
        ...input.controlPlaneEvidence,
        runtimeAttestationIds: [...input.controlPlaneEvidence.runtimeAttestationIds].sort(),
      },
    }),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** 收敛初始压缩材料为 digest 输入形态（未选择恒为 null）。 */
function normalizeInitialContextCompression(
  value: InitialContextCompression | null,
): InitialContextCompression | null {
  if (!value) return null;
  return {
    checkpointId: value.checkpointId,
    summaryHash: value.summaryHash,
    sourceRangesHash: value.sourceRangesHash,
  };
}

/**
 * T33：校验初始压缩材料描述本身格式合法。
 *
 * 只校验形状；存在性/tenant/用途/内容一致/有效期/访问权限由
 * `lib/context/initial-checkpoint-source.ts` 在事务外的受控读取中核验。
 */
export function assertInitialContextCompression(value: InitialContextCompression | null): void {
  if (value === null) return;
  if (!value.checkpointId) {
    throw new ExecutionBindingEvidenceError("initialContextCompression.checkpointId 不能为空");
  }
  if (!SHA256.test(value.summaryHash)) {
    throw new ExecutionBindingEvidenceError("initialContextCompression.summaryHash 格式非法");
  }
  if (!SHA256.test(value.sourceRangesHash)) {
    throw new ExecutionBindingEvidenceError("initialContextCompression.sourceRangesHash 格式非法");
  }
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
  // 冻结架构：ExecutionBinding 只绑定 Harness Runtime，不再携带任何 Agent evidence。
  // Runtime evidence all-or-nothing：hosted 要求 artifact 全集；
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
