import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
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
import {
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/routes";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import {
  executionBindingTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  runtimeRevisionTable,
  runtimeTable,
} from "@/lib/persistence/schema/runtimes";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { runtimeConformanceRun } from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { and, desc, eq } from "drizzle-orm";

export const mysqlExecutionBindingStore: ExecutionBindingStore = {
  create: (input) =>
    db.transaction(async (tx) => {
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

      const revisions = await lockAndValidateRoute(tx, input);
      await lockAndValidatePublication(tx, {
        tenantId: input.tenantId,
        publicationRecordId: input.controlPlaneEvidence.agentPublicationRecordId,
        subjectType: "agent_revision",
        subjectRevisionId: input.agentRevisionId,
        artifactType: "agent_revision",
        artifactId: revisions.agentRevision.artifactId,
        artifactDigest: input.controlPlaneEvidence.agentArtifactDigest,
        attestationIds: input.controlPlaneEvidence.agentAttestationIds,
      });
      const runtimePublication = await lockAndValidatePublication(tx, {
        tenantId: input.tenantId,
        publicationRecordId: input.controlPlaneEvidence.runtimePublicationRecordId,
        subjectType: "runtime_revision",
        subjectRevisionId: input.runtimeRevisionId,
        artifactType: "runtime_revision",
        artifactId: revisions.runtimeRevision.artifactId,
        artifactDigest: input.controlPlaneEvidence.runtimeArtifactDigest,
        attestationIds: input.controlPlaneEvidence.runtimeAttestationIds,
      });
      if (runtimePublication.conformanceRunId !== input.controlPlaneEvidence.conformanceRunId) {
        throw evidenceError("Runtime Publication 与 Conformance Run 不一致");
      }
      await lockAndValidateConformance(tx, input, revisions.runtimeRevision);

      const capabilityManifestDigest = computeCapabilityManifestDigest({
        agentRevisionId: revisions.agentRevision.id,
        agentInterfaceRequirements: revisions.agentRevision.agentInterfaceRequirementsJson,
        runtimeRevisionId: revisions.runtimeRevision.id,
        runtimeCapabilities: revisions.runtimeRevision.runtimeCapabilitiesJson,
      });
      if (capabilityManifestDigest !== input.controlPlaneEvidence.capabilityManifestDigest) {
        throw evidenceError("Capability Manifest Digest 已变化");
      }

      // §5.1 TODO: 将本函数的内联校验逻辑迁移到 validateBindingEligibility() 统一入口，
      // 使 Binding Store.create() 事务内仅调用 validateBindingEligibility() + insert。
      // 当前内联校验与 validateBindingEligibility() 逻辑一致，但独立维护。

      const evidence = input.controlPlaneEvidence;
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

async function lockAndValidateRoute(tx: Transaction, input: StoreExecutionBindingInput) {
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
  const evidence = input.controlPlaneEvidence;
  if (
    !routeRow ||
    routeRow.route.routeState !== "enabled" ||
    routeRow.route.activeRouteRevisionId !== evidence.routeRevisionId
  ) {
    throw evidenceError("Route 当前投影已变化");
  }

  const [revision] = await tx
    .select()
    .from(routeRevision)
    .where(
      and(
        eq(routeRevision.id, evidence.routeRevisionId),
        eq(routeRevision.tenantId, input.tenantId),
        eq(routeRevision.routeId, input.deploymentRouteId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !revision ||
    revision.agentRevisionId !== input.agentRevisionId ||
    revision.runtimeRevisionId !== input.runtimeRevisionId ||
    revision.policyRevisionId !== input.policyRevisionId ||
    revision.contentDigest !== evidence.routeContentDigest
  ) {
    throw evidenceError("RouteRevision 内容与解析结果不一致");
  }

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
    activation.activationState !== "active"
  ) {
    throw evidenceError("RouteActivation 已失效或已被替换");
  }

  const [agentRevision, runtimeRevision] = await Promise.all([
    tx
      .select()
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.id, input.agentRevisionId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null),
    tx
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, input.runtimeRevisionId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null),
  ]);
  if (
    !agentRevision ||
    agentRevision.revisionState !== "published" ||
    agentRevision.artifactDigest !== evidence.agentArtifactDigest
  ) {
    throw evidenceError("AgentRevision 发布状态或 Artifact Digest 不一致");
  }
  if (
    !runtimeRevision ||
    runtimeRevision.revisionState !== "published" ||
    runtimeRevision.artifactDigest !== evidence.runtimeArtifactDigest ||
    runtimeRevision.configHash !== evidence.runtimeConfigDigest
  ) {
    throw evidenceError("RuntimeRevision 发布状态、Artifact 或 Config Digest 不一致");
  }

  const [agent, runtime] = await Promise.all([
    tx
      .select({ id: agentTable.id, lifecycleState: agentTable.lifecycleState })
      .from(agentTable)
      .where(and(eq(agentTable.id, agentRevision.agentId), eq(agentTable.tenantId, input.tenantId)))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null),
    tx
      .select({ id: runtimeTable.id, lifecycleState: runtimeTable.lifecycleState })
      .from(runtimeTable)
      .where(
        and(
          eq(runtimeTable.id, runtimeRevision.runtimeId),
          eq(runtimeTable.tenantId, input.tenantId),
        ),
      )
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null),
  ]);
  if (
    !agent ||
    agent.lifecycleState !== "enabled" ||
    !runtime ||
    runtime.lifecycleState !== "enabled"
  ) {
    throw evidenceError("Agent 或 Runtime 当前不可用于新执行");
  }

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

async function lockAndValidatePublication(
  tx: Transaction,
  params: {
    tenantId: string;
    publicationRecordId: string;
    subjectType: "agent_revision" | "runtime_revision";
    subjectRevisionId: string;
    artifactType: "agent_revision" | "runtime_revision";
    artifactId: string | null;
    artifactDigest: string;
    attestationIds: string[];
  },
) {
  const [publication] = await tx
    .select()
    .from(publicationRecord)
    .where(
      and(
        eq(publicationRecord.id, params.publicationRecordId),
        eq(publicationRecord.tenantId, params.tenantId),
        eq(publicationRecord.subjectType, params.subjectType),
        eq(publicationRecord.subjectRevisionId, params.subjectRevisionId),
      ),
    )
    .limit(1)
    .for("update");
  if (!publication || !sameIds(publication.attestationIds, params.attestationIds)) {
    throw evidenceError(`${params.subjectType} PublicationRecord 或 Attestation 集不一致`);
  }
  const [withdrawal] = await tx
    .select({ id: withdrawalRecord.id })
    .from(withdrawalRecord)
    .where(eq(withdrawalRecord.publicationRecordId, publication.id))
    .limit(1);
  if (withdrawal) throw evidenceError(`${params.subjectType} PublicationRecord 已撤回`);
  if (!params.artifactId) throw evidenceError(`${params.subjectType} 未绑定 Artifact`);

  for (const attestationId of params.attestationIds) {
    const [row] = await tx
      .select({ attestation: artifactAttestation, artifact })
      .from(artifactAttestation)
      .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
      .where(
        and(
          eq(artifactAttestation.id, attestationId),
          eq(artifactAttestation.tenantId, params.tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (
      !row ||
      row.attestation.artifactType !== params.artifactType ||
      row.attestation.artifactRevisionId !== params.subjectRevisionId ||
      row.attestation.artifactId !== params.artifactId ||
      row.attestation.artifactDigest !== params.artifactDigest ||
      row.attestation.verificationState !== "verified" ||
      row.attestation.revokedAt ||
      row.artifact.tenantId !== params.tenantId ||
      row.artifact.digest !== params.artifactDigest
    ) {
      throw evidenceError(`${params.artifactType} Attestation 无效`);
    }
    const [revocation] = await tx
      .select({ id: attestationRevocationRecord.id })
      .from(attestationRevocationRecord)
      .where(eq(attestationRevocationRecord.attestationId, attestationId))
      .limit(1);
    if (revocation) throw evidenceError(`${params.artifactType} Attestation 已撤销`);
  }
  return publication;
}

async function lockAndValidateConformance(
  tx: Transaction,
  input: StoreExecutionBindingInput,
  revision: typeof runtimeRevisionTable.$inferSelect,
): Promise<void> {
  const [run] = await tx
    .select()
    .from(runtimeConformanceRun)
    .where(
      and(
        eq(runtimeConformanceRun.id, input.controlPlaneEvidence.conformanceRunId),
        eq(runtimeConformanceRun.tenantId, input.tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !run ||
    run.overallResult !== "passed" ||
    run.runtimeRevisionId !== revision.id ||
    run.runtimeArtifactDigest !== input.controlPlaneEvidence.runtimeArtifactDigest ||
    run.runtimeConfigDigest !== input.controlPlaneEvidence.runtimeConfigDigest ||
    run.protocolContractRevision !== revision.protocolContractRevision
  ) {
    throw evidenceError("RuntimeConformanceRun 与 RuntimeRevision 不一致");
  }
}

function toExecutionBinding(row: typeof executionBindingTable.$inferSelect): ExecutionBinding {
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
    !row.conformanceRunId
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
    configHash: row.configHash,
    boundAt: row.boundAt,
  };
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function evidenceError(message: string): ExecutionBindingEvidenceError {
  return new ExecutionBindingEvidenceError(message);
}
