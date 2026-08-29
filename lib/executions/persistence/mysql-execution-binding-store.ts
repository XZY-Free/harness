/**
 * ExecutionBinding Store — MySQL 实现。
 *
 * : 统一事务 — 资格校验 + 行级锁 + Insert 在单一 db.transaction 内完成。
 * : validateBindingEligibility(tx, input) — tx 必须传入，复用 Store 事务。
 *
 * 事务内执行：
 * 1. Lock Invocation（FOR UPDATE）+ 检查重复 Binding
 * 2. /: validateBindingEligibility(tx, input) — tx 必传，统一 Policy 校验
 * （Projection 版本 + Route Activation + Evidence Snapshot + Policy）
 * 3. : Lock + TOCTOU 一致性校验（FOR UPDATE + Digest/ID 比较）
 * 4. : Capability Manifest Digest 一致性
 * 5. Insert
 */

import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { validateBindingEligibility } from "@/lib/executions/application/validate-binding-eligibility";
import {
  type ExecutionBinding,
  ExecutionBindingAlreadyExistsError,
  ExecutionBindingEvidenceError,
} from "@/lib/executions/domain/execution-binding";
import type {
  ExecutionBindingStore,
  StoreExecutionBindingInput,
} from "@/lib/executions/persistence/execution-binding-store";
import { GOVERNANCE_CONFIG_SET_KEY } from "@/lib/governance/config";
import { computePolicyRulesHash } from "@/lib/identity/tenant-bootstrap";
import {
  listPoliciesByRevision,
  loadPolicySetAndRevision,
  toRulesDigestInput,
} from "@/lib/permission/policy-queries";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/permission";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { computePublicationEvidenceSetDigest } from "@/lib/publications/domain/publication-record";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { routeEligibilityProjection } from "@/lib/routes/projection/route-eligibility-projection-record";
import { validateRuntimePublicationConformanceEvidence } from "@/lib/runtime/domain/runtime-conformance-eligibility";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { and, asc, desc, eq } from "drizzle-orm";

/** 唯一固定锁序：同一事务内必须逐条获取，禁止 Promise.all 并行锁。 */
export const EXECUTION_BINDING_AUTHORITY_LOCK_ORDER = [
  "Invocation",
  "DeploymentRoute+DeploymentRouteSet",
  "RouteActivation",
  "RouteRevision",
  "Runtime",
  "RuntimeRevision",
  "RuntimePublicationRecord",
  "RuntimeWithdrawalRecord",
  "RuntimeArtifact",
  "RuntimeArtifactAttestation",
  "RuntimeAttestationRevocation",
  "RuntimeConformanceRun",
  "RuntimeConformanceCaseResult",
  "PolicySet",
  "PolicyRevision",
  "RouteEligibilityProjection",
] as const;

export const mysqlExecutionBindingStore: ExecutionBindingStore = {
  create: (input) =>
    db.transaction(async (tx) => {
      // 1. Lock Invocation（FOR UPDATE）+ 检查重复 Binding
      const [invocation] = await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(
          and(
            eq(invocationTable.id, input.invocationId),
            eq(invocationTable.tenantId, input.tenantId),
          ),
        )
        .limit(1)
        .for("update");
      if (!invocation) throw evidenceError("Invocation 不存在或租户不匹配");

      const [existing] = await tx
        .select({ id: executionBindingTable.invocationId })
        .from(executionBindingTable)
        .where(eq(executionBindingTable.invocationId, input.invocationId))
        .limit(1);
      if (existing) throw new ExecutionBindingAlreadyExistsError(input.invocationId);

      // 2. /: 统一资格校验（tx 必须传入，复用 Store 事务）
      const evidence = input.controlPlaneEvidence;
      const eligibility = await validateBindingEligibility(tx, {
        tenantId: input.tenantId,
        routeId: input.deploymentRouteId,
        routeRevisionId: evidence.routeRevisionId,
        routeActivationId: evidence.routeActivationId,
        runtimeRevisionId: input.runtimeRevisionId,
        policyRevisionId: input.policyRevisionId,
        projectionVersionNo: input.projectionVersionNo,
        frozenEvidence: {
          runtimePublicationRecordId: evidence.runtimePublicationRecordId,
          runtimeAttestationIds: [...evidence.runtimeAttestationIds].sort(),
          conformanceRunId: evidence.conformanceRunId,
        },
      });
      if (!eligibility.valid) {
        throw evidenceError(`Binding 资格校验失败: ${eligibility.reason}`);
      }

      // 3. : Lock + TOCTOU 一致性校验（仅 Digest/ID 比较，不做 Policy）
      const revisions = await lockAndVerifyRoute(tx, input);

      // 4. : Capability Manifest Digest 一致性（TOCTOU 防御）
      // 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，无 Agent 维度。
      const capabilityManifestDigest = computeCapabilityManifestDigest({
        runtimeRevisionId: revisions.runtimeRevision.id,
        runtimeCapabilities: revisions.runtimeRevision.runtimeCapabilitiesJson,
      });
      if (capabilityManifestDigest !== input.controlPlaneEvidence.capabilityManifestDigest) {
        throw evidenceError("Capability Manifest Digest 已变化");
      }

      // 5. Insert
      await tx.insert(executionBindingTable).values({
        invocationId: input.invocationId,
        tenantId: input.tenantId,
        runtimeRevisionId: input.runtimeRevisionId,
        deploymentRouteId: input.deploymentRouteId,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        modelRevisionRef: input.modelRevisionRef,
        initialEnvironmentLeaseId: input.initialEnvironmentLeaseId,
        workspaceBindingId: input.workspaceBindingId,
        policyRevisionId: input.policyRevisionId,
        policyRulesDigest: input.policyRulesDigest,
        governanceConfigRevisionId: input.governanceConfigRevisionId,
        governanceConfigDigest: input.governanceConfigDigest,
        contextCheckpointId: input.contextCheckpointId,
        routeRevisionId: evidence.routeRevisionId,
        routeActivationId: evidence.routeActivationId,
        routeContentDigest: evidence.routeContentDigest,
        runtimeArtifactId: evidence.runtimeArtifactId,
        runtimeArtifactDigest: evidence.runtimeArtifactDigest,
        runtimeEvidenceKind: evidence.runtimeEvidenceKind,
        runtimeConfigDigest: evidence.runtimeConfigDigest,
        runtimeTargetDigest: evidence.runtimeTargetDigest,
        capabilityManifestDigest: evidence.capabilityManifestDigest,
        runtimeAttestationIds: [...evidence.runtimeAttestationIds].sort(),
        runtimePublicationRecordId: evidence.runtimePublicationRecordId,
        conformanceRunId: evidence.conformanceRunId,
        resolutionInputDigest: evidence.resolutionInputDigest,
        projectionVersionNo: input.projectionVersionNo,
        environmentDefinitionRevisionId: input.environmentDefinitionRevisionId,
        configHash: input.configHash,
        boundAt: input.boundAt,
      });

      const [created] = await tx
        .select()
        .from(executionBindingTable)
        .where(eq(executionBindingTable.invocationId, input.invocationId))
        .limit(1);
      if (!created) throw new Error("ExecutionBinding 插入后无法回读");
      return toExecutionBinding(created);
    }),
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * : Lock + TOCTOU 一致性校验。
 *
 * 仅做 Digest/ID 一致性比较（防御 Resolver 与 Store 之间的 TOCTOU）。
 * 不再做 Publication/Attestation/Conformance 的 Policy 校验 — 那些已由
 * validateBindingEligibility() + RevisionExecutionEligibilityPolicy 统一执行。
 */
async function lockAndVerifyRoute(tx: Transaction, input: StoreExecutionBindingInput) {
  const evidence = input.controlPlaneEvidence;
  // 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，无 Agent 维度。

  // A. Route + RouteSet（FOR UPDATE）
  const [routeRow] = await tx
    .select({ route: deploymentRouteTable, routeSet: deploymentRouteSetTable })
    .from(deploymentRouteTable)
    .innerJoin(
      deploymentRouteSetTable,
      eq(deploymentRouteSetTable.id, deploymentRouteTable.routeSetId),
    )
    .where(
      and(
        eq(deploymentRouteTable.id, input.deploymentRouteId),
        eq(deploymentRouteSetTable.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (!routeRow || routeRow.route.routeState !== "enabled") {
    throw evidenceError("Route 当前投影已变化");
  }

  // B. RouteActivation（FOR UPDATE）— 当前最新 + Active + 一致
  const [activation] = await tx
    .select()
    .from(routeActivation)
    .where(
      and(
        eq(routeActivation.tenantId, input.tenantId),
        eq(routeActivation.routeId, input.deploymentRouteId),
      ),
    )
    .orderBy(desc(routeActivation.activationSequence))
    .limit(1)
    .for("update");
  if (
    !activation ||
    activation.id !== evidence.routeActivationId ||
    activation.routeRevisionId !== evidence.routeRevisionId ||
    activation.routeSetId !== routeRow.routeSet.id ||
    activation.activationState !== "active"
  ) {
    throw evidenceError("RouteActivation 已失效或已被替换");
  }

  // C. RouteRevision（FOR UPDATE）— 仅 latest Activation 指向的 Revision 是权威
  const [revision] = await tx
    .select()
    .from(routeRevision)
    .where(eq(routeRevision.id, activation.routeRevisionId))
    .limit(1)
    .for("update");
  if (
    !revision ||
    revision.tenantId !== input.tenantId ||
    revision.routeId !== input.deploymentRouteId ||
    revision.routeSetId !== routeRow.routeSet.id ||
    revision.runtimeRevisionId !== input.runtimeRevisionId ||
    // §10：Route 显式指定 PolicyRevision 时，Binding 必须与其一致；
    // Route 未指定（null）→ Tenant baseline fallback，effective 由 lockAndVerifyPolicy 校验。
    (revision.policyRevisionId !== null && revision.policyRevisionId !== input.policyRevisionId) ||
    revision.contentDigest !== evidence.routeContentDigest
  ) {
    throw evidenceError("RouteRevision 内容与解析结果不一致");
  }

  // E. Runtime → RuntimeRevision（FOR UPDATE），严格串行获取
  const [runtimeRevisionKey] = await tx
    .select({ runtimeId: runtimeRevisionTable.runtimeId })
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, input.runtimeRevisionId))
    .limit(1);
  if (!runtimeRevisionKey) throw evidenceError("RuntimeRevision 不存在");
  const [runtime] = await tx
    .select({ id: runtimeTable.id, lifecycleState: runtimeTable.lifecycleState })
    .from(runtimeTable)
    .where(
      and(
        eq(runtimeTable.id, runtimeRevisionKey.runtimeId),
        eq(runtimeTable.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  const [runtimeRevision] = await tx
    .select()
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, input.runtimeRevisionId))
    .limit(1)
    .for("update");
  if (
    !runtime ||
    runtime.lifecycleState !== "enabled" ||
    !runtimeRevision ||
    runtimeRevision.runtimeId !== runtime.id ||
    runtimeRevision.revisionState !== "published" ||
    runtimeRevision.runtimeEvidenceKind !== evidence.runtimeEvidenceKind ||
    (evidence.runtimeEvidenceKind === "hosted_artifact" &&
      (runtimeRevision.artifactDigest !== evidence.runtimeArtifactDigest ||
        runtimeRevision.artifactId !== evidence.runtimeArtifactId)) ||
    runtimeRevision.configHash !== evidence.runtimeConfigDigest ||
    runtimeRevision.runtimeTargetDigest !== evidence.runtimeTargetDigest
  ) {
    throw evidenceError("RuntimeRevision 发布状态、证据种类、Artifact 或 Config Digest 不一致");
  }

  // F. 冻结 Publication → Withdrawal（FOR UPDATE）— 严格串行、精确全集
  const publications = await lockAndVerifyPublications(tx, input);

  // G. 冻结 Attestation → Revocation（FOR UPDATE）— 按冻结 ID 排序逐条锁
  await lockAndVerifyAttestations(tx, input);

  // H. 冻结 ConformanceRun → CaseResult（FOR UPDATE）— 精确 Run 与完整合同
  const conformanceRun = await lockAndVerifyConformance(tx, input, runtimeRevision);
  // Batch 3：Runtime Publication 的 evidenceSetDigest 冻结了 target digest 附加证据，
  // 重算时须与 publish-runtime-revision 的 additionalEvidence 完全一致（03 §6）。
  validateFrozenPublicationEvidenceDigest({
    publication: publications.runtimePublication,
    additionalEvidence: {
      evidenceManifestDigest: conformanceRun.evidenceManifestDigest,
      runtime_target_digest: runtimeRevision.runtimeTargetDigest,
      runtime_evidence_kind: runtimeRevision.runtimeEvidenceKind,
    },
  });

  // I. PolicyRevision → Projection（FOR UPDATE）— 最终 authority 锁与精确冻结校验（§10/§42）
  await lockAndVerifyPolicy(tx, input, revision.policyRevisionId);
  // J. GovernanceRevision（FOR UPDATE）— 最终 authority 锁与精确冻结校验（§11/§42）
  await lockAndVerifyGovernance(tx, input);
  await lockAndVerifyProjection(tx, input);
  return { runtimeRevision };
}

async function lockAndVerifyPolicy(
  tx: Transaction,
  input: StoreExecutionBindingInput,
  routePolicyRevisionId: string | null,
): Promise<void> {
  // §10：有效 Policy = Route 显式指定 ?? Tenant baseline currentRevisionId（effective 永远非空）。
  let effectivePolicyRevisionId = routePolicyRevisionId;
  if (!effectivePolicyRevisionId) {
    const { set: tenantSet } = await loadPolicySetAndRevision(tx, input.tenantId);
    if (!tenantSet.currentRevisionId) throw staleEvidenceError("PolicySet 无 currentRevisionId");
    effectivePolicyRevisionId = tenantSet.currentRevisionId;
  }
  if (effectivePolicyRevisionId !== input.policyRevisionId) {
    throw staleEvidenceError("有效 PolicyRevision 与冻结不一致");
  }

  const [policyKey] = await tx
    .select({ policySetId: policyRevisionTable.policySetId })
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, input.policyRevisionId))
    .limit(1);
  if (!policyKey) throw staleEvidenceError("PolicyRevision 已漂移");
  const [policySet] = await tx
    .select({
      id: policySetTable.id,
      tenantId: policySetTable.tenantId,
      lifecycleState: policySetTable.lifecycleState,
    })
    .from(policySetTable)
    .where(eq(policySetTable.id, policyKey.policySetId))
    .limit(1)
    .for("update");
  const [policyRevision] = await tx
    .select({
      id: policyRevisionTable.id,
      policySetId: policyRevisionTable.policySetId,
      defaultDecision: policyRevisionTable.defaultDecision,
      rulesHash: policyRevisionTable.rulesHash,
      revisionState: policyRevisionTable.revisionState,
    })
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, input.policyRevisionId))
    .limit(1)
    .for("update");
  if (!policySet || policySet.lifecycleState !== "enabled") {
    throw staleEvidenceError("PolicySet 非 enabled");
  }
  validateFrozenPolicyAuthority({
    policy:
      policySet && policyRevision
        ? {
            id: policyRevision.id,
            policySetId: policyRevision.policySetId,
            tenantId: policySet.tenantId,
            revisionState: policyRevision.revisionState,
          }
        : null,
    expected: {
      policyRevisionId: input.policyRevisionId,
      policySetId: policyKey.policySetId,
      tenantId: input.tenantId,
    },
  });

  // §10：重算 rulesHash 必须与冻结 digest 一致（否则 fail-closed，不 Binding）。
  // 上一节 validateFrozenPolicyAuthority 已保证 policyRevision 存在（否则已抛出）。
  if (!policyRevision) {
    throw staleEvidenceError("Policy Revision 不存在");
  }
  const rules = await listPoliciesByRevision(tx, input.policyRevisionId);
  const recomputedRulesHash = computePolicyRulesHash(
    policyRevision.defaultDecision,
    toRulesDigestInput(rules),
  );
  if (recomputedRulesHash !== input.policyRulesDigest) {
    throw staleEvidenceError("Policy rulesHash 与冻结 digest 不一致");
  }
  if (recomputedRulesHash !== policyRevision.rulesHash) {
    throw staleEvidenceError("Policy Revision 存储 rulesHash 与内容不一致");
  }
}

/**
 * §11：Governance 不由 Route 选 — 冻结 Tenant GovernanceConfigSet("runtime-execution") 的
 * current published Revision，并校验 configDigest 一致（fail-closed）。
 */
async function lockAndVerifyGovernance(
  tx: Transaction,
  input: StoreExecutionBindingInput,
): Promise<void> {
  const [governanceSet] = await tx
    .select({
      id: governanceConfigSetTable.id,
      tenantId: governanceConfigSetTable.tenantId,
      lifecycleState: governanceConfigSetTable.lifecycleState,
      currentRevisionId: governanceConfigSetTable.currentRevisionId,
      configSetKey: governanceConfigSetTable.configSetKey,
    })
    .from(governanceConfigSetTable)
    .where(
      and(
        eq(governanceConfigSetTable.tenantId, input.tenantId),
        eq(governanceConfigSetTable.configSetKey, GOVERNANCE_CONFIG_SET_KEY),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !governanceSet ||
    governanceSet.lifecycleState !== "enabled" ||
    !governanceSet.currentRevisionId ||
    governanceSet.currentRevisionId !== input.governanceConfigRevisionId
  ) {
    throw staleEvidenceError("GovernanceConfigSet 非 enabled 或 current Revision 不一致");
  }
  const [governanceRevision] = await tx
    .select({
      id: governanceConfigRevisionTable.id,
      configSetId: governanceConfigRevisionTable.configSetId,
      configDigest: governanceConfigRevisionTable.configDigest,
      revisionState: governanceConfigRevisionTable.revisionState,
    })
    .from(governanceConfigRevisionTable)
    .where(eq(governanceConfigRevisionTable.id, governanceSet.currentRevisionId))
    .limit(1)
    .for("update");
  if (
    !governanceRevision ||
    governanceRevision.configSetId !== governanceSet.id ||
    governanceRevision.revisionState !== "published" ||
    governanceRevision.configDigest !== input.governanceConfigDigest
  ) {
    throw staleEvidenceError("GovernanceConfigRevision 非 published 或 digest 不一致");
  }
}

export function validateFrozenPolicyAuthority(input: {
  policy: { id: string; policySetId: string; tenantId: string; revisionState: string } | null;
  expected: { policyRevisionId: string; policySetId: string; tenantId: string };
}): void {
  if (
    !input.policy ||
    input.policy.id !== input.expected.policyRevisionId ||
    input.policy.policySetId !== input.expected.policySetId ||
    input.policy.tenantId !== input.expected.tenantId ||
    input.policy.revisionState !== "published"
  ) {
    throw staleEvidenceError("PolicyRevision 已漂移");
  }
}

async function lockAndVerifyProjection(
  tx: Transaction,
  input: StoreExecutionBindingInput,
): Promise<void> {
  const evidence = input.controlPlaneEvidence;
  const [projection] = await tx
    .select({
      routeId: routeEligibilityProjection.routeId,
      tenantId: routeEligibilityProjection.tenantId,
      eligibilityState: routeEligibilityProjection.eligibilityState,
      activationState: routeEligibilityProjection.activationState,
      projectionVersionNo: routeEligibilityProjection.projectionVersionNo,
      routeRevisionId: routeEligibilityProjection.routeRevisionId,
      routeActivationId: routeEligibilityProjection.routeActivationId,
      runtimeRevisionId: routeEligibilityProjection.runtimeRevisionId,
      policyRevisionId: routeEligibilityProjection.policyRevisionId,
      routeContentDigest: routeEligibilityProjection.routeContentDigest,
      runtimeArtifactId: routeEligibilityProjection.runtimeArtifactId,
      runtimeArtifactDigest: routeEligibilityProjection.runtimeArtifactDigest,
      runtimeEvidenceKind: routeEligibilityProjection.runtimeEvidenceKind,
      runtimeConfigDigest: routeEligibilityProjection.runtimeConfigDigest,
      runtimeTargetDigest: routeEligibilityProjection.runtimeTargetDigest,
      capabilityCompatibilityDigest: routeEligibilityProjection.capabilityCompatibilityDigest,
      runtimePublicationRecordId: routeEligibilityProjection.runtimePublicationRecordId,
      runtimeAttestationIds: routeEligibilityProjection.runtimeAttestationIds,
      conformanceRunId: routeEligibilityProjection.conformanceRunId,
    })
    .from(routeEligibilityProjection)
    .where(
      and(
        eq(routeEligibilityProjection.routeId, input.deploymentRouteId),
        eq(routeEligibilityProjection.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  validateFrozenProjectionAuthority({
    projection: projection ?? null,
    expected: {
      routeId: input.deploymentRouteId,
      tenantId: input.tenantId,
      projectionVersionNo: input.projectionVersionNo,
      routeRevisionId: evidence.routeRevisionId,
      routeActivationId: evidence.routeActivationId,
      runtimeRevisionId: input.runtimeRevisionId,
      routeContentDigest: evidence.routeContentDigest,
      runtimeArtifactDigest: evidence.runtimeArtifactDigest,
      runtimeEvidenceKind: evidence.runtimeEvidenceKind,
      runtimeConfigDigest: evidence.runtimeConfigDigest,
      runtimeTargetDigest: evidence.runtimeTargetDigest,
      capabilityManifestDigest: evidence.capabilityManifestDigest,
      runtimePublicationRecordId: evidence.runtimePublicationRecordId,
      runtimeArtifactId: evidence.runtimeArtifactId,
      runtimeAttestationIds: evidence.runtimeAttestationIds,
      conformanceRunId: evidence.conformanceRunId,
    },
  });
}

type FrozenProjectionRow = {
  routeId: string;
  tenantId: string;
  eligibilityState: "eligible" | "ineligible" | "pending_rebuild";
  activationState: "active" | "disabled";
  projectionVersionNo: number;
  routeRevisionId: string;
  routeActivationId: string;
  runtimeRevisionId: string;
  policyRevisionId: string | null;
  routeContentDigest: string;
  /** null = external_endpoint Runtime（03 §3）。 */
  runtimeArtifactId: string | null;
  /** null = external_endpoint Runtime（03 §3）。 */
  runtimeArtifactDigest: string | null;
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  runtimeConfigDigest: string | null;
  runtimeTargetDigest: string | null;
  capabilityCompatibilityDigest: string;
  runtimePublicationRecordId: string | null;
  runtimeAttestationIds: string[] | null;
  conformanceRunId: string | null;
};

type FrozenProjectionExpectation = {
  routeId: string;
  tenantId: string;
  projectionVersionNo: number;
  routeRevisionId: string;
  routeActivationId: string;
  runtimeRevisionId: string;
  routeContentDigest: string;
  /** null = external_endpoint Runtime（03 §3）。 */
  runtimeArtifactId: string | null;
  /** null = external_endpoint Runtime（03 §3）。 */
  runtimeArtifactDigest: string | null;
  runtimeEvidenceKind: "hosted_artifact" | "external_endpoint";
  runtimeConfigDigest: string;
  runtimeTargetDigest: string;
  capabilityManifestDigest: string;
  runtimePublicationRecordId: string;
  runtimeAttestationIds: string[];
  conformanceRunId: string;
};

export function validateFrozenProjectionAuthority(input: {
  projection: FrozenProjectionRow | null;
  expected: FrozenProjectionExpectation;
}): void {
  const { projection, expected } = input;
  // external_endpoint Runtime 的 Attestation 集合为空（03 §3，不伪造）；hosted 要求非空全集。
  const runtimeAttestationsExact =
    expected.runtimeEvidenceKind === "external_endpoint"
      ? areExactIdSetsAllowEmpty(
          projection?.runtimeAttestationIds ?? [],
          expected.runtimeAttestationIds,
          {
            allowEmpty: true,
          },
        )
      : !!projection?.runtimeAttestationIds &&
        areExactNonEmptyIdSets(projection.runtimeAttestationIds, expected.runtimeAttestationIds);
  if (
    !projection ||
    projection.routeId !== expected.routeId ||
    projection.tenantId !== expected.tenantId ||
    projection.eligibilityState !== "eligible" ||
    projection.activationState !== "active" ||
    projection.projectionVersionNo !== expected.projectionVersionNo ||
    projection.routeRevisionId !== expected.routeRevisionId ||
    projection.routeActivationId !== expected.routeActivationId ||
    projection.runtimeRevisionId !== expected.runtimeRevisionId ||
    projection.routeContentDigest !== expected.routeContentDigest ||
    projection.runtimeArtifactId !== expected.runtimeArtifactId ||
    projection.runtimeArtifactDigest !== expected.runtimeArtifactDigest ||
    projection.runtimeConfigDigest !== expected.runtimeConfigDigest ||
    projection.runtimeTargetDigest !== expected.runtimeTargetDigest ||
    projection.runtimeEvidenceKind !== expected.runtimeEvidenceKind ||
    projection.capabilityCompatibilityDigest !== expected.capabilityManifestDigest ||
    projection.runtimePublicationRecordId !== expected.runtimePublicationRecordId ||
    projection.conformanceRunId !== expected.conformanceRunId ||
    !runtimeAttestationsExact
  ) {
    throw staleEvidenceError("RouteEligibilityProjection 已漂移");
  }
}

function staleEvidenceError(detail: string): ExecutionBindingEvidenceError {
  return evidenceError(`eligibility_snapshot_stale: ${detail}`);
}

async function lockAndVerifyPublications(
  tx: Transaction,
  input: StoreExecutionBindingInput,
): Promise<{
  runtimePublication: LockedPublicationEvidence;
}> {
  const evidence = input.controlPlaneEvidence;
  // 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，无 Agent Publication 维度。

  const [runtimePublication] = await tx
    .select({
      id: publicationRecord.id,
      tenantId: publicationRecord.tenantId,
      subjectType: publicationRecord.subjectType,
      subjectRevisionId: publicationRecord.subjectRevisionId,
      attestationIds: publicationRecord.attestationIds,
      conformanceRunId: publicationRecord.conformanceRunId,
      evidenceSetDigest: publicationRecord.evidenceSetDigest,
      approvals: publicationRecord.approvals,
    })
    .from(publicationRecord)
    .where(eq(publicationRecord.id, evidence.runtimePublicationRecordId))
    .limit(1)
    .for("update");
  const [runtimeWithdrawal] = await tx
    .select({ id: withdrawalRecord.id })
    .from(withdrawalRecord)
    .where(eq(withdrawalRecord.publicationRecordId, evidence.runtimePublicationRecordId))
    .limit(1)
    .for("update");
  validateFrozenPublicationAuthority({
    publication: runtimePublication ?? null,
    withdrawal: runtimeWithdrawal ?? null,
    expected: {
      publicationRecordId: evidence.runtimePublicationRecordId,
      tenantId: input.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: input.runtimeRevisionId,
      attestationIds: evidence.runtimeAttestationIds,
      conformanceRunId: evidence.conformanceRunId,
      allowEmptyAttestations: evidence.runtimeEvidenceKind === "external_endpoint",
    },
  });
  if (!runtimePublication) throw evidenceError("冻结 Runtime Publication 不存在");
  return {
    runtimePublication,
  };
}

type LockedPublicationEvidence = {
  evidenceSetDigest: string;
  attestationIds: string[];
  conformanceRunId: string | null;
  approvals: unknown[];
};

export function validateFrozenPublicationEvidenceDigest(input: {
  publication: LockedPublicationEvidence;
  additionalEvidence?: unknown;
}): void {
  const actual = computePublicationEvidenceSetDigest({
    attestationIds: input.publication.attestationIds,
    conformanceRunId: input.publication.conformanceRunId,
    approvals: input.publication.approvals,
    ...(input.additionalEvidence === undefined
      ? {}
      : { additionalEvidence: input.additionalEvidence }),
  });
  if (actual !== input.publication.evidenceSetDigest) {
    throw evidenceError("Publication Evidence Set Digest 与锁后证据不一致");
  }
}

async function lockAndVerifyConformance(
  tx: Transaction,
  input: StoreExecutionBindingInput,
  runtimeRevision: typeof runtimeRevisionTable.$inferSelect,
): Promise<FrozenConformanceRun> {
  const evidence = input.controlPlaneEvidence;
  const [run] = await tx
    .select({
      id: runtimeConformanceRun.id,
      tenantId: runtimeConformanceRun.tenantId,
      runtimeRevisionId: runtimeConformanceRun.runtimeRevisionId,
      runtimeTargetDigest: runtimeConformanceRun.runtimeTargetDigest,
      runtimeConfigDigest: runtimeConformanceRun.runtimeConfigDigest,
      protocolContractRevision: runtimeConformanceRun.protocolContractRevision,
      suiteRevision: runtimeConformanceRun.suiteRevision,
      overallResult: runtimeConformanceRun.overallResult,
      conformanceFormat: runtimeConformanceRun.conformanceFormat,
      startedAt: runtimeConformanceRun.startedAt,
      completedAt: runtimeConformanceRun.completedAt,
      verifiedAt: runtimeConformanceRun.verifiedAt,
      evidenceManifestDigest: runtimeConformanceRun.evidenceManifestDigest,
    })
    .from(runtimeConformanceRun)
    .where(eq(runtimeConformanceRun.id, evidence.conformanceRunId))
    .limit(1)
    .for("update");
  const caseResults = await tx
    .select({
      caseId: runtimeConformanceCaseResult.caseId,
      passed: runtimeConformanceCaseResult.passed,
    })
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, evidence.conformanceRunId))
    .orderBy(asc(runtimeConformanceCaseResult.caseId))
    .for("update");

  validateFrozenConformanceAuthority({
    run: run ?? null,
    caseResults,
    expected: {
      conformanceRunId: evidence.conformanceRunId,
      tenantId: input.tenantId,
      runtimeRevisionId: input.runtimeRevisionId,
      runtimeTargetDigest: runtimeRevision.runtimeTargetDigest,
      runtimeConfigDigest: evidence.runtimeConfigDigest,
      protocolContractRevision: runtimeRevision.protocolContractRevision,
    },
  });
  if (!run) throw evidenceError("冻结 ConformanceRun 不存在");
  return run;
}

type FrozenConformanceRun = {
  id: string;
  tenantId: string;
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
  suiteRevision: string;
  overallResult: "passed" | "failed" | "error" | "cancelled";
  conformanceFormat: "standard_dsse";
  startedAt: Date;
  completedAt: Date | null;
  verifiedAt: Date | null;
  evidenceManifestDigest: string;
};

type FrozenConformanceExpectation = {
  conformanceRunId: string;
  tenantId: string;
  runtimeRevisionId: string;
  runtimeTargetDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
};

export function validateFrozenConformanceAuthority(input: {
  run: FrozenConformanceRun | null;
  caseResults: Array<{ caseId: string; passed: boolean }>;
  expected: FrozenConformanceExpectation;
}): void {
  const { run, caseResults, expected } = input;
  if (!run || run.id !== expected.conformanceRunId) {
    throw evidenceError("冻结 ConformanceRun 不存在或 ID 不一致");
  }
  if (
    !(run.completedAt instanceof Date) ||
    !Number.isFinite(run.completedAt.getTime()) ||
    run.completedAt < run.startedAt ||
    !(run.verifiedAt instanceof Date) ||
    !Number.isFinite(run.verifiedAt.getTime())
  ) {
    throw evidenceError("冻结 ConformanceRun 未完成或未验证");
  }

  // 复用同一纯验证函数对锁后事实复验（非第二套 Policy）。
  const result = validateRuntimePublicationConformanceEvidence({
    run: {
      runId: run.id,
      tenantId: run.tenantId,
      runtimeRevisionId: run.runtimeRevisionId,
      overallResult: run.overallResult,
      runtimeTargetDigest: run.runtimeTargetDigest,
      runtimeConfigDigest: run.runtimeConfigDigest,
      protocolContractRevision: run.protocolContractRevision,
      suiteRevision: run.suiteRevision,
      conformanceFormat: run.conformanceFormat,
    },
    caseResults,
    expected: {
      tenantId: expected.tenantId,
      runtimeRevisionId: expected.runtimeRevisionId,
      runtimeTargetDigest: expected.runtimeTargetDigest,
      runtimeConfigDigest: expected.runtimeConfigDigest,
      protocolContractRevision: expected.protocolContractRevision,
      allowedFormats: ["standard_dsse"],
    },
  });
  if (!result.valid) {
    throw evidenceError(
      `冻结 ConformanceRun 不满足执行资格: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
}

async function lockAndVerifyAttestations(
  tx: Transaction,
  input: StoreExecutionBindingInput,
): Promise<void> {
  const evidence = input.controlPlaneEvidence;
  // Agent 是源码不可见黑盒 → 无 Agent Artifact Attestation（不伪造）。
  // 仅 hosted_artifact Runtime 携带 Attestation（03 §3）；external 集合为空不会进入。

  for (const attestationId of [...evidence.runtimeAttestationIds].sort()) {
    // 仅 hosted_artifact 携带 Runtime Attestation（03 §3）；external 集合为空不会进入。
    const runtimeArtifactId = evidence.runtimeArtifactId as string;
    const runtimeArtifactDigest = evidence.runtimeArtifactDigest as string;
    const [attestationKey] = await tx
      .select({ artifactId: artifactAttestation.artifactId })
      .from(artifactAttestation)
      .where(eq(artifactAttestation.id, attestationId))
      .limit(1);
    if (!attestationKey?.artifactId) {
      throw evidenceError(`冻结 Attestation ${attestationId} 缺少 Artifact`);
    }
    if (attestationKey.artifactId !== runtimeArtifactId) {
      throw evidenceError(`冻结 Attestation ${attestationId} 的 Artifact 已漂移`);
    }
    const [artifactRow] = await tx
      .select({
        id: artifact.id,
        tenantId: artifact.tenantId,
        kind: artifact.kind,
        digest: artifact.digest,
      })
      .from(artifact)
      .where(eq(artifact.id, runtimeArtifactId))
      .limit(1)
      .for("update");
    const [attestation] = await tx
      .select({
        id: artifactAttestation.id,
        artifactId: artifactAttestation.artifactId,
        tenantId: artifactAttestation.tenantId,
        artifactType: artifactAttestation.artifactType,
        artifactRevisionId: artifactAttestation.artifactRevisionId,
        artifactDigest: artifactAttestation.artifactDigest,
        verificationState: artifactAttestation.verificationState,
      })
      .from(artifactAttestation)
      .where(eq(artifactAttestation.id, attestationId))
      .limit(1)
      .for("update");
    validateFrozenArtifactAuthority({
      artifact: artifactRow ?? null,
      attestationArtifactId: attestation?.artifactId ?? null,
      expected: {
        artifactId: runtimeArtifactId,
        tenantId: input.tenantId,
        artifactKind: "runtime_revision",
        artifactDigest: runtimeArtifactDigest,
      },
    });
    const [revocation] = await tx
      .select({ id: attestationRevocationRecord.id })
      .from(attestationRevocationRecord)
      .where(eq(attestationRevocationRecord.attestationId, attestationId))
      .limit(1)
      .for("update");
    validateFrozenAttestationAuthority({
      attestation: attestation ?? null,
      revocation: revocation ?? null,
      expected: {
        attestationId,
        tenantId: input.tenantId,
        artifactType: "runtime_revision",
        artifactRevisionId: input.runtimeRevisionId,
        artifactDigest: runtimeArtifactDigest,
      },
    });
  }
}

export function validateFrozenArtifactAuthority(input: {
  artifact: { id: string; tenantId: string; kind: string; digest: string } | null;
  attestationArtifactId: string | null;
  expected: {
    artifactId: string;
    tenantId: string;
    artifactKind: "runtime_revision";
    artifactDigest: string;
  };
}): void {
  const { artifact: artifactRow, attestationArtifactId, expected } = input;
  if (
    !artifactRow ||
    !attestationArtifactId ||
    artifactRow.id !== expected.artifactId ||
    attestationArtifactId !== artifactRow.id ||
    artifactRow.tenantId !== expected.tenantId ||
    artifactRow.kind !== expected.artifactKind ||
    artifactRow.digest !== expected.artifactDigest
  ) {
    throw evidenceError("冻结 Attestation 的 Artifact 权威已漂移");
  }
}

type FrozenAttestationRow = {
  id: string;
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactDigest: string;
  verificationState: "pending" | "verified" | "failed";
};

type FrozenAttestationExpectation = {
  attestationId: string;
  tenantId: string;
  artifactType: "runtime_revision";
  artifactRevisionId: string;
  artifactDigest: string;
};

export function validateFrozenAttestationAuthority(input: {
  attestation: FrozenAttestationRow | null;
  revocation: { id: string } | null;
  expected: FrozenAttestationExpectation;
}): void {
  const { attestation, revocation, expected } = input;
  if (
    !attestation ||
    attestation.id !== expected.attestationId ||
    attestation.tenantId !== expected.tenantId ||
    attestation.artifactType !== expected.artifactType ||
    attestation.artifactRevisionId !== expected.artifactRevisionId ||
    attestation.artifactDigest !== expected.artifactDigest ||
    attestation.verificationState !== "verified"
  ) {
    throw evidenceError("冻结 Attestation 与当前制品权威或验证状态不一致");
  }
  if (revocation) {
    throw evidenceError(`冻结 Attestation ${attestation.id} 已有撤销记录`);
  }
}

type FrozenPublicationRow = {
  id: string;
  tenantId: string;
  subjectType: "agent_revision" | "runtime_revision";
  subjectRevisionId: string;
  attestationIds: string[];
  conformanceRunId: string | null;
};

type FrozenPublicationExpectation = {
  publicationRecordId: string;
  tenantId: string;
  subjectType: "agent_revision" | "runtime_revision";
  /** null = 基础 Harness Route（无 Agent 资产约束）。 */
  subjectRevisionId: string | null;
  attestationIds: string[];
  conformanceRunId: string | null;
  /** external_endpoint Runtime 无 Artifact Attestation（03 §3）→ 空集合合法。 */
  allowEmptyAttestations?: boolean;
};

export function validateFrozenPublicationAuthority(input: {
  publication: FrozenPublicationRow | null;
  withdrawal: { id: string } | null;
  expected: FrozenPublicationExpectation;
}): void {
  const { publication, withdrawal, expected } = input;
  if (
    !publication ||
    publication.id !== expected.publicationRecordId ||
    publication.tenantId !== expected.tenantId ||
    publication.subjectType !== expected.subjectType ||
    publication.subjectRevisionId !== expected.subjectRevisionId
  ) {
    throw evidenceError("冻结 Publication 与租户、主体或 Revision 不一致");
  }
  if (withdrawal) {
    throw evidenceError(`冻结 Publication ${publication.id} 已撤回`);
  }
  if (
    !areExactIdSetsAllowEmpty(publication.attestationIds, expected.attestationIds, {
      allowEmpty: expected.allowEmptyAttestations === true,
    })
  ) {
    throw evidenceError("冻结 Publication 的 Attestation IDs 不是当前精确全集");
  }
  if (publication.conformanceRunId !== expected.conformanceRunId) {
    throw evidenceError("冻结 Publication 的 ConformanceRun 不一致");
  }
}

function areExactIdSetsAllowEmpty(
  current: string[],
  frozen: string[],
  options?: { allowEmpty?: boolean },
): boolean {
  if (current.length === 0 && frozen.length === 0) return options?.allowEmpty === true;
  return areExactNonEmptyIdSets(current, frozen);
}

function areExactNonEmptyIdSets(current: string[], frozen: string[]): boolean {
  if (current.length === 0 || frozen.length === 0) return false;
  if (
    current.some((id) => id.length === 0) ||
    frozen.some((id) => id.length === 0) ||
    new Set(current).size !== current.length ||
    new Set(frozen).size !== frozen.length
  ) {
    return false;
  }
  const sortedCurrent = [...current].sort();
  const sortedFrozen = [...frozen].sort();
  return (
    sortedCurrent.length === sortedFrozen.length &&
    sortedCurrent.every((id, index) => id === sortedFrozen[index])
  );
}

export function toExecutionBinding(
  row: typeof executionBindingTable.$inferSelect,
): ExecutionBinding {
  const runtimeFieldsComplete =
    !!row.routeRevisionId &&
    !!row.routeActivationId &&
    !!row.routeContentDigest &&
    (row.runtimeEvidenceKind === "external_endpoint" ||
      (!!row.runtimeArtifactId && !!row.runtimeArtifactDigest)) &&
    !!row.runtimeConfigDigest &&
    !!row.runtimeTargetDigest &&
    !!row.capabilityManifestDigest &&
    !!row.runtimeAttestationIds &&
    !!row.runtimePublicationRecordId &&
    !!row.conformanceRunId &&
    !!row.resolutionInputDigest &&
    Number.isInteger(row.projectionVersionNo) &&
    row.projectionVersionNo >= 0;
  if (!runtimeFieldsComplete) {
    throw evidenceError("新建 Binding 回读时证据字段不完整");
  }
  return {
    invocationId: row.invocationId,
    tenantId: row.tenantId,
    runtimeRevisionId: row.runtimeRevisionId,
    deploymentRouteId: row.deploymentRouteId,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    modelRevisionRef: row.modelRevisionRef,
    initialEnvironmentLeaseId: row.initialEnvironmentLeaseId,
    workspaceBindingId: row.workspaceBindingId,
    policyRevisionId: row.policyRevisionId,
    policyRulesDigest: row.policyRulesDigest,
    governanceConfigRevisionId: row.governanceConfigRevisionId,
    governanceConfigDigest: row.governanceConfigDigest,
    contextCheckpointId: row.contextCheckpointId,
    environmentDefinitionRevisionId: row.environmentDefinitionRevisionId,
    routeRevisionId: row.routeRevisionId,
    routeActivationId: row.routeActivationId,
    routeContentDigest: row.routeContentDigest,
    runtimeArtifactId: row.runtimeArtifactId,
    runtimeArtifactDigest: row.runtimeArtifactDigest,
    runtimeConfigDigest: row.runtimeConfigDigest,
    runtimeTargetDigest: row.runtimeTargetDigest,
    runtimeEvidenceKind: row.runtimeEvidenceKind,
    capabilityManifestDigest: row.capabilityManifestDigest,
    runtimeAttestationIds: [...row.runtimeAttestationIds],
    runtimePublicationRecordId: row.runtimePublicationRecordId,
    conformanceRunId: row.conformanceRunId,
    resolutionInputDigest: row.resolutionInputDigest,
    projectionVersionNo: row.projectionVersionNo,
    configHash: row.configHash,
    boundAt: row.boundAt,
  };
}

function evidenceError(message: string): ExecutionBindingEvidenceError {
  return new ExecutionBindingEvidenceError(message);
}
