/**
 * 测试专用的无控制面证据 ExecutionBinding 写入夹具。
 *
 * 事实源：
 * - docs/architecture/persistence.md （ExecutionBinding L405-423）
 * - docs/architecture/agent-control-plane.md §6（Invocation 生命周期）
 * - docs/architecture/runtime-control-plane.md
 *
 * 仅供旧集成测试构造历史数据；生产调度必须通过正式 Application Service
 * 校验 Route、Publication、Attestation 和 Conformance 证据。
 *
 * 关键约束：
 * - 一条 Invocation 恰有一条不可变绑定（invocationId 为主键，1:1）。
 * - 启动后不可变：只有 create，没有 update。
 * - Route 更新不修改进行中的 ExecutionBinding（affects_new_invocations_only）。
 */
import { db } from "@/lib/db/client";
import {
  type ExecutionBindingConfigInput,
  type ExecutionBindingControlPlaneEvidence,
  computeExecutionBindingConfigHash,
} from "@/lib/executions/domain/execution-binding";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
import { executionBindingTable } from "@/lib/persistence/schema/executions";
import { ExecutionBindingAlreadyExistsError } from "@/lib/runtime/errors";
import {
  type ExecutionSubject,
  freezeTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import { eq } from "drizzle-orm";
import { testCapabilityCatalogBindingFields } from "./test-capability-catalog";

type TestCapabilityCatalogBindingFields = ReturnType<typeof testCapabilityCatalogBindingFields>;

/** 旧状态机测试显式写入的完整、不可空 Binding 证据。 */
export const TEST_EXECUTION_BINDING_EVIDENCE: ExecutionBindingControlPlaneEvidence = {
  routeRevisionId: "test-route-revision",
  routeActivationId: "test-route-activation",
  routeContentDigest: `sha256:${"1".repeat(64)}`,
  runtimeArtifactId: "test-runtime-artifact",
  runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
  runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
  runtimeEvidenceKind: "hosted_artifact" as const,
  runtimeTargetDigest: `sha256:${"5".repeat(64)}`,
  capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
  runtimeAttestationIds: ["test-runtime-attestation"],
  runtimePublicationRecordId: "test-runtime-publication",
  conformanceRunId: "test-conformance-run",
  resolutionInputDigest: `sha256:${"6".repeat(64)}`,
};

export const TEST_EXECUTION_BINDING_REQUIRED_FIELDS = {
  controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
  projectionVersionNo: 1,
  policyRevisionId: "22222222-2222-4222-8222-222222222222",
  policyRulesDigest: `sha256:${"a".repeat(64)}`,
  governanceConfigRevisionId: "33333333-3333-4333-8333-333333333333",
  governanceConfigDigest: `sha256:${"b".repeat(64)}`,
} as const;

/** createExecutionBinding 入参。 */
export interface CreateExecutionBindingParams {
  invocationId: string;
  tenantId: string;
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef?: string | null;
  workspaceBindingId?: string;
  policyRevisionId?: string | null;
  policyRulesDigest?: string;
  governanceConfigRevisionId?: string;
  governanceConfigDigest?: string;
  environmentDefinitionRevisionId?: string | null;
  environmentMode?: "MANAGED" | "NO_PLATFORM_ENVIRONMENT";
  controlPlaneEvidence: ExecutionBindingControlPlaneEvidence;
  projectionVersionNo: number;
  executionSubject?: ExecutionSubject;
  /** 需要验证特定能力目录的测试可显式覆盖默认空目录。 */
  capabilityCatalogFields?: TestCapabilityCatalogBindingFields;
}

/** computeBindingConfigHash 入参（与 CreateExecutionBindingParams 字段一致，便于规范化）。 */
export interface BindingConfigHashInput {
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
  workspaceBindingId?: string | null;
  policyRevisionId: string | null;
  policyRulesDigest?: string;
  governanceConfigRevisionId?: string;
  governanceConfigDigest?: string;
  environmentDefinitionRevisionId?: string | null;
  environmentMode?: "MANAGED" | "NO_PLATFORM_ENVIRONMENT";
  controlPlaneEvidence?: ExecutionBindingControlPlaneEvidence;
  capabilityCatalogFields?: TestCapabilityCatalogBindingFields;
}

/**
 * 计算 ExecutionBinding 的 configHash（sha256，递归排序 key 保证稳定）。
 *
 * 事实源：L423 "config_hash 由规范化字段后 SHA-256 计算"。
 * 规范化：递归排序 JSON key，null 字段统一为 null，避免字段顺序影响 hash。
 *
 * 返回格式：`sha256:<64hex>`。
 */
export function computeBindingConfigHash(input: BindingConfigHashInput): string {
  const catalog =
    input.capabilityCatalogFields ?? testCapabilityCatalogBindingFields("hash-fixture");
  const evidence = input.controlPlaneEvidence ?? TEST_EXECUTION_BINDING_EVIDENCE;
  const current: ExecutionBindingConfigInput = {
    runtimeRevisionId: input.runtimeRevisionId,
    deploymentRouteId: input.deploymentRouteId,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    modelRevisionRef: input.modelRevisionRef,
    workspaceBindingId: input.workspaceBindingId ?? "workspace-binding-fixture",
    policyRevisionId: input.policyRevisionId ?? "22222222-2222-4222-8222-222222222222",
    policyRulesDigest: input.policyRulesDigest ?? `sha256:${"a".repeat(64)}`,
    governanceConfigRevisionId:
      input.governanceConfigRevisionId ?? "33333333-3333-4333-8333-333333333333",
    governanceConfigDigest: input.governanceConfigDigest ?? `sha256:${"b".repeat(64)}`,
    environmentDefinitionRevisionId: input.environmentDefinitionRevisionId ?? null,
    environmentMode: input.environmentMode ?? "NO_PLATFORM_ENVIRONMENT",
    capabilityCatalogJson: catalog.capabilityCatalogJson,
    capabilityCatalogDigest: catalog.capabilityCatalogDigest,
    capabilityCatalogVersion: catalog.capabilityCatalogVersion,
    capabilityCatalogSourceRefs: catalog.capabilityCatalogSourceRefs,
    capabilityCatalogCreatedAt: catalog.capabilityCatalogCreatedAt,
    controlPlaneEvidence: evidence,
    projectionVersionNo: 1,
    principalType: catalog.principalType,
    principalId: catalog.principalId,
    principalSource: catalog.principalSource,
    principalFrozenAt: catalog.principalFrozenAt,
  };
  return computeExecutionBindingConfigHash(current);
}

/**
 * 创建 ExecutionBinding（不可变，1:1）。
 *
 * 流程：
 * 1. 校验同 invocationId 是否已有 Binding（已存在 → ExecutionBindingAlreadyExistsError）。
 * 2. 计算 configHash（规范化字段后 SHA-256）。
 * 3. INSERT ExecutionBinding。
 * 4. 返回 ExecutionBinding。
 *
 * @throws ExecutionBindingAlreadyExistsError 同一 Invocation 已有 Binding
 */
export async function createExecutionBinding(
  params: CreateExecutionBindingParams & Record<string, unknown>,
): Promise<ExecutionBinding> {
  // 1. 校验同 invocationId 是否已有 Binding
  const [existing] = await db
    .select({ id: executionBindingTable.invocationId })
    .from(executionBindingTable)
    .where(eq(executionBindingTable.invocationId, params.invocationId))
    .limit(1);
  if (existing) {
    throw new ExecutionBindingAlreadyExistsError(params.invocationId);
  }

  // 2. 计算 configHash
  const configHash = computeBindingConfigHash({
    runtimeRevisionId: params.runtimeRevisionId,
    deploymentRouteId: params.deploymentRouteId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelRevisionRef: params.modelRevisionRef ?? null,
    workspaceBindingId: params.workspaceBindingId ?? null,
    policyRevisionId: params.policyRevisionId ?? null,
    policyRulesDigest: params.policyRulesDigest,
    governanceConfigRevisionId: params.governanceConfigRevisionId,
    governanceConfigDigest: params.governanceConfigDigest,
    environmentDefinitionRevisionId: params.environmentDefinitionRevisionId ?? null,
    environmentMode:
      params.environmentMode ??
      (params.environmentDefinitionRevisionId ? "MANAGED" : "NO_PLATFORM_ENVIRONMENT"),
  });

  // 3. INSERT ExecutionBinding（invocationId 为主键，1:1）
  await db.insert(executionBindingTable).values({
    ...(params.capabilityCatalogFields ?? testCapabilityCatalogBindingFields(params.invocationId)),
    ...(params.executionSubject
      ? freezeTrustedExecutionSubject(params.executionSubject, params.tenantId)
      : {}),
    invocationId: params.invocationId,
    tenantId: params.tenantId,
    runtimeRevisionId: params.runtimeRevisionId,
    deploymentRouteId: params.deploymentRouteId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelRevisionRef: params.modelRevisionRef ?? null,
    workspaceBindingId: params.workspaceBindingId ?? params.invocationId,
    policyRevisionId: params.policyRevisionId ?? "22222222-2222-4222-8222-222222222222",
    policyRulesDigest: params.policyRulesDigest ?? `sha256:${"a".repeat(64)}`,
    governanceConfigRevisionId:
      params.governanceConfigRevisionId ?? "33333333-3333-4333-8333-333333333333",
    governanceConfigDigest: params.governanceConfigDigest ?? `sha256:${"b".repeat(64)}`,
    routeRevisionId: params.controlPlaneEvidence.routeRevisionId,
    routeActivationId: params.controlPlaneEvidence.routeActivationId,
    routeContentDigest: params.controlPlaneEvidence.routeContentDigest,
    runtimeArtifactId: params.controlPlaneEvidence.runtimeArtifactId,
    runtimeArtifactDigest: params.controlPlaneEvidence.runtimeArtifactDigest,
    runtimeConfigDigest: params.controlPlaneEvidence.runtimeConfigDigest,
    runtimeTargetDigest: params.controlPlaneEvidence.runtimeTargetDigest,
    runtimeEvidenceKind: params.controlPlaneEvidence.runtimeEvidenceKind,
    capabilityManifestDigest: params.controlPlaneEvidence.capabilityManifestDigest,
    runtimeAttestationIds: params.controlPlaneEvidence.runtimeAttestationIds,
    runtimePublicationRecordId: params.controlPlaneEvidence.runtimePublicationRecordId,
    conformanceRunId: params.controlPlaneEvidence.conformanceRunId,
    resolutionInputDigest: params.controlPlaneEvidence.resolutionInputDigest,
    projectionVersionNo: params.projectionVersionNo,
    environmentMode:
      params.environmentMode ??
      (params.environmentDefinitionRevisionId ? "MANAGED" : "NO_PLATFORM_ENVIRONMENT"),
    environmentDefinitionRevisionId: params.environmentDefinitionRevisionId ?? null,
    configHash,
  });

  // 4. 回读
  const [row] = await db
    .select()
    .from(executionBindingTable)
    .where(eq(executionBindingTable.invocationId, params.invocationId))
    .limit(1);
  if (!row) {
    throw new Error(
      `createExecutionBinding: ExecutionBinding 行未找到（invocationId=${params.invocationId}）`,
    );
  }
  return row;
}
