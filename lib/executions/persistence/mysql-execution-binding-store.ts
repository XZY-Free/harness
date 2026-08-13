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
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/control-plane";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
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
import { validateCompleteConformanceResult } from "@/lib/runtime/domain/runtime-conformance-contract";
import { ConformanceEligibilityPolicy } from "@/lib/runtime/domain/runtime-conformance-eligibility";
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
  "Agent",
  "AgentRevision",
  "Runtime",
  "RuntimeRevision",
  "AgentPublicationRecord",
  "AgentWithdrawalRecord",
  "RuntimePublicationRecord",
  "RuntimeWithdrawalRecord",
  "AgentArtifact",
  "AgentArtifactAttestation",
  "AgentAttestationRevocation",
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
        agentRevisionId: input.agentRevisionId,
        runtimeRevisionId: input.runtimeRevisionId,
        policyRevisionId: input.policyRevisionId,
        projectionVersionNo: input.projectionVersionNo,
        frozenEvidence: {
          agentPublicationRecordId: evidence.agentPublicationRecordId,
          runtimePublicationRecordId: evidence.runtimePublicationRecordId,
          agentAttestationIds: [...evidence.agentAttestationIds].sort(),
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
      const capabilityManifestDigest = computeCapabilityManifestDigest({
        agentRevisionId: revisions.agentRevision.id,
        agentInterfaceRequirements: revisions.agentRevision.agentInterfaceRequirementsJson,
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
        agentRevisionId: input.agentRevisionId,
        runtimeRevisionId: input.runtimeRevisionId,
        deploymentRouteId: input.deploymentRouteId,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        modelRevisionRef: input.modelRevisionRef,
        initialEnvironmentLeaseId: input.initialEnvironmentLeaseId,
        workspaceBindingId: input.workspaceBindingId,
        policyRevisionId: input.policyRevisionId,
        contextCheckpointId: input.contextCheckpointId,
        routeRevisionId: evidence.routeRevisionId,
        routeActivationId: evidence.routeActivationId,
        routeContentDigest: evidence.routeContentDigest,
        agentArtifactId: evidence.agentArtifactId,
        runtimeArtifactId: evidence.runtimeArtifactId,
        agentArtifactDigest: evidence.agentArtifactDigest,
        runtimeArtifactDigest: evidence.runtimeArtifactDigest,
        runtimeConfigDigest: evidence.runtimeConfigDigest,
        capabilityManifestDigest: evidence.capabilityManifestDigest,
        agentAttestationIds: [...evidence.agentAttestationIds].sort(),
        runtimeAttestationIds: [...evidence.runtimeAttestationIds].sort(),
        agentPublicationRecordId: evidence.agentPublicationRecordId,
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
    revision.agentRevisionId !== input.agentRevisionId ||
    revision.runtimeRevisionId !== input.runtimeRevisionId ||
    revision.policyRevisionId !== input.policyRevisionId ||
    revision.contentDigest !== evidence.routeContentDigest
  ) {
    throw evidenceError("RouteRevision 内容与解析结果不一致");
  }

  // D. Agent → AgentRevision（FOR UPDATE），只用预读键定位主体，最终判断全部基于锁后行
  const [agentRevisionKey] = await tx
    .select({ agentId: agentRevisionTable.agentId })
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, input.agentRevisionId))
    .limit(1);
  if (!agentRevisionKey) throw evidenceError("AgentRevision 不存在");
  const [agent] = await tx
    .select({ id: agentTable.id, lifecycleState: agentTable.lifecycleState })
    .from(agentTable)
    .where(
      and(eq(agentTable.id, agentRevisionKey.agentId), eq(agentTable.tenantId, input.tenantId)),
    )
    .limit(1)
    .for("update");
  const [agentRevision] = await tx
    .select()
    .from(agentRevisionTable)
    .where(eq(agentRevisionTable.id, input.agentRevisionId))
    .limit(1)
    .for("update");
  if (
    !agent ||
    agent.lifecycleState !== "enabled" ||
    !agentRevision ||
    agentRevision.agentId !== agent.id ||
    agentRevision.revisionState !== "published" ||
    agentRevision.artifactDigest !== evidence.agentArtifactDigest
  ) {
    throw evidenceError("Agent 或 AgentRevision 当前权威事实不一致");
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
    runtimeRevision.artifactDigest !== evidence.runtimeArtifactDigest ||
    runtimeRevision.configHash !== evidence.runtimeConfigDigest
  ) {
    throw evidenceError("RuntimeRevision 发布状态、Artifact 或 Config Digest 不一致");
  }

  // F. 冻结 Publication → Withdrawal（FOR UPDATE）— 严格串行、精确全集
  const publications = await lockAndVerifyPublications(tx, input);

  // G. 冻结 Attestation → Revocation（FOR UPDATE）— 按冻结 ID 排序逐条锁
  await lockAndVerifyAttestations(tx, input);

  // H. 冻结 ConformanceRun → CaseResult（FOR UPDATE）— 精确 Run 与完整合同
  const conformanceRun = await lockAndVerifyConformance(tx, input, runtimeRevision);
  validateFrozenPublicationEvidenceDigest({
    publication: publications.runtimePublication,
    additionalEvidence: { evidenceManifestDigest: conformanceRun.evidenceManifestDigest },
  });

  // I. PolicyRevision → Projection（FOR UPDATE）— 最终 authority 锁与精确冻结校验
  await lockAndVerifyPolicy(tx, input);
  await lockAndVerifyProjection(tx, input);
  return { agentRevision, runtimeRevision };
}

async function lockAndVerifyPolicy(
  tx: Transaction,
  input: StoreExecutionBindingInput,
): Promise<void> {
  if (!input.policyRevisionId) return;
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
    })
    .from(policySetTable)
    .where(eq(policySetTable.id, policyKey.policySetId))
    .limit(1)
    .for("update");
  const [policyRevision] = await tx
    .select({
      id: policyRevisionTable.id,
      policySetId: policyRevisionTable.policySetId,
      revisionState: policyRevisionTable.revisionState,
    })
    .from(policyRevisionTable)
    .where(eq(policyRevisionTable.id, input.policyRevisionId))
    .limit(1)
    .for("update");
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
      agentRevisionId: routeEligibilityProjection.agentRevisionId,
      runtimeRevisionId: routeEligibilityProjection.runtimeRevisionId,
      policyRevisionId: routeEligibilityProjection.policyRevisionId,
      routeContentDigest: routeEligibilityProjection.routeContentDigest,
      agentArtifactId: routeEligibilityProjection.agentArtifactId,
      runtimeArtifactId: routeEligibilityProjection.runtimeArtifactId,
      agentArtifactDigest: routeEligibilityProjection.agentArtifactDigest,
      runtimeArtifactDigest: routeEligibilityProjection.runtimeArtifactDigest,
      runtimeConfigDigest: routeEligibilityProjection.runtimeConfigDigest,
      capabilityCompatibilityDigest: routeEligibilityProjection.capabilityCompatibilityDigest,
      agentPublicationRecordId: routeEligibilityProjection.agentPublicationRecordId,
      runtimePublicationRecordId: routeEligibilityProjection.runtimePublicationRecordId,
      agentAttestationIds: routeEligibilityProjection.agentAttestationIds,
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
      agentRevisionId: input.agentRevisionId,
      runtimeRevisionId: input.runtimeRevisionId,
      policyRevisionId: input.policyRevisionId,
      routeContentDigest: evidence.routeContentDigest,
      agentArtifactDigest: evidence.agentArtifactDigest,
      runtimeArtifactDigest: evidence.runtimeArtifactDigest,
      runtimeConfigDigest: evidence.runtimeConfigDigest,
      capabilityManifestDigest: evidence.capabilityManifestDigest,
      agentPublicationRecordId: evidence.agentPublicationRecordId,
      runtimePublicationRecordId: evidence.runtimePublicationRecordId,
      agentArtifactId: evidence.agentArtifactId,
      runtimeArtifactId: evidence.runtimeArtifactId,
      agentAttestationIds: evidence.agentAttestationIds,
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
  agentRevisionId: string;
  runtimeRevisionId: string;
  policyRevisionId: string | null;
  routeContentDigest: string;
  agentArtifactId: string | null;
  runtimeArtifactId: string | null;
  agentArtifactDigest: string | null;
  runtimeArtifactDigest: string | null;
  runtimeConfigDigest: string | null;
  capabilityCompatibilityDigest: string;
  agentPublicationRecordId: string | null;
  runtimePublicationRecordId: string | null;
  agentAttestationIds: string[] | null;
  runtimeAttestationIds: string[] | null;
  conformanceRunId: string | null;
};

type FrozenProjectionExpectation = {
  routeId: string;
  tenantId: string;
  projectionVersionNo: number;
  routeRevisionId: string;
  routeActivationId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
  policyRevisionId: string | null;
  routeContentDigest: string;
  agentArtifactId: string;
  runtimeArtifactId: string;
  agentArtifactDigest: string;
  runtimeArtifactDigest: string;
  runtimeConfigDigest: string;
  capabilityManifestDigest: string;
  agentPublicationRecordId: string;
  runtimePublicationRecordId: string;
  agentAttestationIds: string[];
  runtimeAttestationIds: string[];
  conformanceRunId: string;
};

export function validateFrozenProjectionAuthority(input: {
  projection: FrozenProjectionRow | null;
  expected: FrozenProjectionExpectation;
}): void {
  const { projection, expected } = input;
  if (
    !projection ||
    projection.routeId !== expected.routeId ||
    projection.tenantId !== expected.tenantId ||
    projection.eligibilityState !== "eligible" ||
    projection.activationState !== "active" ||
    projection.projectionVersionNo !== expected.projectionVersionNo ||
    projection.routeRevisionId !== expected.routeRevisionId ||
    projection.routeActivationId !== expected.routeActivationId ||
    projection.agentRevisionId !== expected.agentRevisionId ||
    projection.runtimeRevisionId !== expected.runtimeRevisionId ||
    projection.policyRevisionId !== expected.policyRevisionId ||
    projection.routeContentDigest !== expected.routeContentDigest ||
    projection.agentArtifactId !== expected.agentArtifactId ||
    projection.runtimeArtifactId !== expected.runtimeArtifactId ||
    projection.agentArtifactDigest !== expected.agentArtifactDigest ||
    projection.runtimeArtifactDigest !== expected.runtimeArtifactDigest ||
    projection.runtimeConfigDigest !== expected.runtimeConfigDigest ||
    projection.capabilityCompatibilityDigest !== expected.capabilityManifestDigest ||
    projection.agentPublicationRecordId !== expected.agentPublicationRecordId ||
    projection.runtimePublicationRecordId !== expected.runtimePublicationRecordId ||
    projection.conformanceRunId !== expected.conformanceRunId ||
    !projection.agentAttestationIds ||
    !projection.runtimeAttestationIds ||
    !areExactNonEmptyIdSets(projection.agentAttestationIds, expected.agentAttestationIds) ||
    !areExactNonEmptyIdSets(projection.runtimeAttestationIds, expected.runtimeAttestationIds)
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
  agentPublication: LockedPublicationEvidence;
  runtimePublication: LockedPublicationEvidence;
}> {
  const evidence = input.controlPlaneEvidence;

  const [agentPublication] = await tx
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
    .where(eq(publicationRecord.id, evidence.agentPublicationRecordId))
    .limit(1)
    .for("update");
  const [agentWithdrawal] = await tx
    .select({ id: withdrawalRecord.id })
    .from(withdrawalRecord)
    .where(eq(withdrawalRecord.publicationRecordId, evidence.agentPublicationRecordId))
    .limit(1)
    .for("update");
  validateFrozenPublicationAuthority({
    publication: agentPublication ?? null,
    withdrawal: agentWithdrawal ?? null,
    expected: {
      publicationRecordId: evidence.agentPublicationRecordId,
      tenantId: input.tenantId,
      subjectType: "agent_revision",
      subjectRevisionId: input.agentRevisionId,
      attestationIds: evidence.agentAttestationIds,
      conformanceRunId: null,
    },
  });
  if (!agentPublication) throw evidenceError("冻结 Agent Publication 不存在");
  validateFrozenPublicationEvidenceDigest({ publication: agentPublication });

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
    },
  });
  if (!runtimePublication) throw evidenceError("冻结 Runtime Publication 不存在");
  return {
    agentPublication,
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
      runtimeArtifactDigest: runtimeConformanceRun.runtimeArtifactDigest,
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
      runtimeArtifactDigest: evidence.runtimeArtifactDigest,
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
  runtimeArtifactDigest: string;
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
  runtimeArtifactDigest: string;
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

  const completeResult = validateCompleteConformanceResult(caseResults);
  if (!completeResult.valid) {
    throw evidenceError(completeResult.reason);
  }

  const eligibility = ConformanceEligibilityPolicy.isEligible(
    {
      runId: run.id,
      tenantId: run.tenantId,
      runtimeRevisionId: run.runtimeRevisionId,
      overallResult: run.overallResult,
      runtimeArtifactDigest: run.runtimeArtifactDigest,
      runtimeConfigDigest: run.runtimeConfigDigest,
      protocolContractRevision: run.protocolContractRevision,
      suiteRevision: run.suiteRevision,
      conformanceFormat: run.conformanceFormat,
      caseResults,
    },
    {
      expectedTenantId: expected.tenantId,
      expectedRuntimeRevisionId: expected.runtimeRevisionId,
      expectedRuntimeArtifactDigest: expected.runtimeArtifactDigest,
      expectedRuntimeConfigDigest: expected.runtimeConfigDigest,
      expectedProtocolContractRevision: expected.protocolContractRevision,
      allowedFormats: ["standard_dsse"],
    },
  );
  if (!eligibility.eligible) {
    throw evidenceError(
      `冻结 ConformanceRun 不满足执行资格: ${eligibility.errors.map((error) => error.code).join(",")}`,
    );
  }
}

async function lockAndVerifyAttestations(
  tx: Transaction,
  input: StoreExecutionBindingInput,
): Promise<void> {
  const evidence = input.controlPlaneEvidence;

  for (const attestationId of [...evidence.agentAttestationIds].sort()) {
    const [attestationKey] = await tx
      .select({ artifactId: artifactAttestation.artifactId })
      .from(artifactAttestation)
      .where(eq(artifactAttestation.id, attestationId))
      .limit(1);
    if (!attestationKey?.artifactId) {
      throw evidenceError(`冻结 Attestation ${attestationId} 缺少 Artifact`);
    }
    if (attestationKey.artifactId !== evidence.agentArtifactId) {
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
      .where(eq(artifact.id, evidence.agentArtifactId))
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
        artifactId: evidence.agentArtifactId,
        tenantId: input.tenantId,
        artifactKind: "agent_revision",
        artifactDigest: evidence.agentArtifactDigest,
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
        artifactType: "agent_revision",
        artifactRevisionId: input.agentRevisionId,
        artifactDigest: evidence.agentArtifactDigest,
      },
    });
  }

  for (const attestationId of [...evidence.runtimeAttestationIds].sort()) {
    const [attestationKey] = await tx
      .select({ artifactId: artifactAttestation.artifactId })
      .from(artifactAttestation)
      .where(eq(artifactAttestation.id, attestationId))
      .limit(1);
    if (!attestationKey?.artifactId) {
      throw evidenceError(`冻结 Attestation ${attestationId} 缺少 Artifact`);
    }
    if (attestationKey.artifactId !== evidence.runtimeArtifactId) {
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
      .where(eq(artifact.id, evidence.runtimeArtifactId))
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
        artifactId: evidence.runtimeArtifactId,
        tenantId: input.tenantId,
        artifactKind: "runtime_revision",
        artifactDigest: evidence.runtimeArtifactDigest,
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
        artifactDigest: evidence.runtimeArtifactDigest,
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
    artifactKind: "agent_revision" | "runtime_revision";
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
  artifactType: "agent_revision" | "runtime_revision";
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
  subjectRevisionId: string;
  attestationIds: string[];
  conformanceRunId: string | null;
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
  if (!areExactNonEmptyIdSets(publication.attestationIds, expected.attestationIds)) {
    throw evidenceError("冻结 Publication 的 Attestation IDs 不是当前精确全集");
  }
  if (publication.conformanceRunId !== expected.conformanceRunId) {
    throw evidenceError("冻结 Publication 的 ConformanceRun 不一致");
  }
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
  if (
    !row.routeRevisionId ||
    !row.routeActivationId ||
    !row.routeContentDigest ||
    !row.agentArtifactId ||
    !row.runtimeArtifactId ||
    !row.agentArtifactDigest ||
    !row.runtimeArtifactDigest ||
    !row.runtimeConfigDigest ||
    !row.capabilityManifestDigest ||
    !row.agentAttestationIds ||
    !row.runtimeAttestationIds ||
    !row.agentPublicationRecordId ||
    !row.runtimePublicationRecordId ||
    !row.conformanceRunId ||
    !row.resolutionInputDigest ||
    !Number.isInteger(row.projectionVersionNo) ||
    row.projectionVersionNo < 0
  ) {
    throw evidenceError("新建 Binding 回读时证据字段不完整");
  }
  return {
    invocationId: row.invocationId,
    tenantId: row.tenantId,
    agentRevisionId: row.agentRevisionId,
    runtimeRevisionId: row.runtimeRevisionId,
    deploymentRouteId: row.deploymentRouteId,
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    modelRevisionRef: row.modelRevisionRef,
    initialEnvironmentLeaseId: row.initialEnvironmentLeaseId,
    workspaceBindingId: row.workspaceBindingId,
    policyRevisionId: row.policyRevisionId,
    contextCheckpointId: row.contextCheckpointId,
    environmentDefinitionRevisionId: row.environmentDefinitionRevisionId,
    routeRevisionId: row.routeRevisionId,
    routeActivationId: row.routeActivationId,
    routeContentDigest: row.routeContentDigest,
    agentArtifactId: row.agentArtifactId,
    runtimeArtifactId: row.runtimeArtifactId,
    agentArtifactDigest: row.agentArtifactDigest,
    runtimeArtifactDigest: row.runtimeArtifactDigest,
    runtimeConfigDigest: row.runtimeConfigDigest,
    capabilityManifestDigest: row.capabilityManifestDigest,
    agentAttestationIds: [...row.agentAttestationIds],
    runtimeAttestationIds: [...row.runtimeAttestationIds],
    agentPublicationRecordId: row.agentPublicationRecordId,
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
