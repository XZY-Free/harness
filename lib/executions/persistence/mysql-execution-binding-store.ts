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

import { db } from "@/lib/db/client";
import {
 artifactAttestation,
 attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
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
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { deploymentRouteSetTable, deploymentRouteTable } from "@/lib/persistence/schema/routes";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
 publicationRecord,
 withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { and, desc, eq } from "drizzle-orm";

/** 唯一固定锁序：同一事务内必须逐条获取，禁止 Promise.all 并行锁。 */
export const EXECUTION_BINDING_AUTHORITY_LOCK_ORDER = [
 "Invocation", "DeploymentRoute+DeploymentRouteSet", "RouteActivation", "RouteRevision",
 "Agent", "AgentRevision", "Runtime", "RuntimeRevision",
 "AgentPublicationRecord", "AgentWithdrawalRecord", "RuntimePublicationRecord", "RuntimeWithdrawalRecord",
 "AgentArtifactAttestation", "AgentAttestationRevocation", "RuntimeArtifactAttestation", "RuntimeAttestationRevocation",
 "RuntimeConformanceRun", "RuntimeConformanceCaseResult", "PolicyRevision", "RouteEligibilityProjection",
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
 .where(and(eq(agentTable.id, agentRevisionKey.agentId), eq(agentTable.tenantId, input.tenantId)))
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
 await lockAndVerifyPublications(tx, input);

 // G. 冻结 Attestation → Revocation（FOR UPDATE）— 按冻结 ID 排序逐条锁
 await lockAndVerifyAttestations(tx, input);

 // H. PolicyRevision（FOR UPDATE）— 状态一致性
 if (input.policyRevisionId) {
 const [policy] = await tx
 .select({ state: policyRevisionTable.revisionState })
 .from(policyRevisionTable)
 .where(eq(policyRevisionTable.id, input.policyRevisionId))
 .limit(1)
 .for("update");
 if (!policy || policy.state !== "published") {
 throw evidenceError("PolicyRevision 不可用于新执行");
 }
 }
 return { agentRevision, runtimeRevision };
}

async function lockAndVerifyPublications(
 tx: Transaction,
 input: StoreExecutionBindingInput,
): Promise<void> {
 const evidence = input.controlPlaneEvidence;

 const [agentPublication] = await tx
 .select({
 id: publicationRecord.id,
 tenantId: publicationRecord.tenantId,
 subjectType: publicationRecord.subjectType,
 subjectRevisionId: publicationRecord.subjectRevisionId,
 attestationIds: publicationRecord.attestationIds,
 conformanceRunId: publicationRecord.conformanceRunId,
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

 const [runtimePublication] = await tx
 .select({
 id: publicationRecord.id,
 tenantId: publicationRecord.tenantId,
 subjectType: publicationRecord.subjectType,
 subjectRevisionId: publicationRecord.subjectRevisionId,
 attestationIds: publicationRecord.attestationIds,
 conformanceRunId: publicationRecord.conformanceRunId,
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
}

async function lockAndVerifyAttestations(
 tx: Transaction,
 input: StoreExecutionBindingInput,
): Promise<void> {
 const evidence = input.controlPlaneEvidence;

 for (const attestationId of [...evidence.agentAttestationIds].sort()) {
 const [attestation] = await tx
 .select({
 id: artifactAttestation.id,
 tenantId: artifactAttestation.tenantId,
 artifactType: artifactAttestation.artifactType,
 artifactRevisionId: artifactAttestation.artifactRevisionId,
 artifactDigest: artifactAttestation.artifactDigest,
 verificationState: artifactAttestation.verificationState,
 revokedAt: artifactAttestation.revokedAt,
 })
 .from(artifactAttestation)
 .where(eq(artifactAttestation.id, attestationId))
 .limit(1)
 .for("update");
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
 const [attestation] = await tx
 .select({
 id: artifactAttestation.id,
 tenantId: artifactAttestation.tenantId,
 artifactType: artifactAttestation.artifactType,
 artifactRevisionId: artifactAttestation.artifactRevisionId,
 artifactDigest: artifactAttestation.artifactDigest,
 verificationState: artifactAttestation.verificationState,
 revokedAt: artifactAttestation.revokedAt,
 })
 .from(artifactAttestation)
 .where(eq(artifactAttestation.id, attestationId))
 .limit(1)
 .for("update");
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

type FrozenAttestationRow = {
 id: string;
 tenantId: string;
 artifactType: string;
 artifactRevisionId: string;
 artifactDigest: string;
 verificationState: "pending" | "verified" | "failed";
 revokedAt: Date | null;
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
 attestation.verificationState !== "verified" ||
 attestation.revokedAt !== null
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
