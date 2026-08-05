import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/agents";
import {
  deploymentRouteSetTable,
  deploymentRouteTable,
} from "@/lib/persistence/schema/routes";
import { policyRevisionTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import {
  publicationRecord,
  withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import {
  type RouteResolutionCandidate,
  computeCapabilityManifestDigest,
} from "@/lib/routes/domain/route-resolution-policy";
import type { RouteResolutionStore } from "@/lib/routes/persistence/route-resolution-store";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { runtimeConformanceRun } from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { and, desc, eq, isNull } from "drizzle-orm";

export const mysqlRouteResolutionStore: RouteResolutionStore = {
  loadCandidates: (input) =>
    db.transaction(async (tx) => {
      const [routeSet] = await tx
        .select()
        .from(deploymentRouteSetTable)
        .where(
          and(
            eq(deploymentRouteSetTable.tenantId, input.tenantId),
            eq(deploymentRouteSetTable.agentId, input.agentId),
            eq(deploymentRouteSetTable.routeScopeKey, input.routeScopeKey),
          ),
        )
        .limit(1);
      if (!routeSet) return [];

      const routes = await tx
        .select()
        .from(deploymentRouteTable)
        .where(eq(deploymentRouteTable.routeSetId, routeSet.id));
      const candidates = await Promise.all(
        routes.map(async (route): Promise<RouteResolutionCandidate | null> => {
          if (!route.activeRouteRevisionId) return null;
          const [revision] = await tx
            .select()
            .from(routeRevision)
            .where(
              and(
                eq(routeRevision.id, route.activeRouteRevisionId),
                eq(routeRevision.tenantId, input.tenantId),
                eq(routeRevision.routeId, route.id),
                eq(routeRevision.routeSetId, routeSet.id),
              ),
            )
            .limit(1);
          if (!revision) return null;
          const [activation] = await tx
            .select()
            .from(routeActivation)
            .where(
              and(
                eq(routeActivation.tenantId, input.tenantId),
                eq(routeActivation.routeId, route.id),
              ),
            )
            .orderBy(desc(routeActivation.activationSequence))
            .limit(1);
          if (!activation || activation.routeRevisionId !== revision.id) return null;

          const [agent, agentRevision, runtimeRevision] = await Promise.all([
            tx
              .select()
              .from(agentTable)
              .where(
                and(
                  eq(agentTable.tenantId, input.tenantId),
                  eq(agentTable.id, routeSet.agentId),
                  isNull(agentTable.deletedAt),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(agentRevisionTable)
              .where(
                and(
                  eq(agentRevisionTable.id, revision.agentRevisionId),
                  eq(agentRevisionTable.agentId, routeSet.agentId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(runtimeRevisionTable)
              .where(eq(runtimeRevisionTable.id, revision.runtimeRevisionId))
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (!agent || !agentRevision || !runtimeRevision) return null;
          const [runtime] = await tx
            .select()
            .from(runtimeTable)
            .where(
              and(
                eq(runtimeTable.tenantId, input.tenantId),
                eq(runtimeTable.id, runtimeRevision.runtimeId),
                isNull(runtimeTable.deletedAt),
              ),
            )
            .limit(1);
          if (!runtime) return null;

          const [agentPublication, runtimePublication] = await Promise.all([
            loadActivePublication(tx, {
              tenantId: input.tenantId,
              subjectType: "agent_revision",
              subjectRevisionId: agentRevision.id,
            }),
            loadActivePublication(tx, {
              tenantId: input.tenantId,
              subjectType: "runtime_revision",
              subjectRevisionId: runtimeRevision.id,
            }),
          ]);
          const [agentEvidenceValid, runtimeEvidenceValid] = await Promise.all([
            validatePublicationEvidence(tx, {
              tenantId: input.tenantId,
              publication: agentPublication,
              artifactType: "agent_revision",
              revisionId: agentRevision.id,
              artifactId: agentRevision.artifactId,
              artifactDigest: agentRevision.artifactDigest,
            }),
            validatePublicationEvidence(tx, {
              tenantId: input.tenantId,
              publication: runtimePublication,
              artifactType: "runtime_revision",
              revisionId: runtimeRevision.id,
              artifactId: runtimeRevision.artifactId,
              artifactDigest: runtimeRevision.artifactDigest,
            }),
          ]);
          const runtimeConformanceValid = await validateRuntimeConformance(tx, {
            tenantId: input.tenantId,
            conformanceRunId: runtimePublication?.conformanceRunId ?? null,
            runtimeRevision,
          });
          const policyRevisionState = revision.policyRevisionId
            ? await tx
                .select({ state: policyRevisionTable.revisionState })
                .from(policyRevisionTable)
                .where(eq(policyRevisionTable.id, revision.policyRevisionId))
                .limit(1)
                .then((rows) => rows[0]?.state ?? "missing")
            : null;
          const controlPlaneEvidence =
            agentPublication &&
            runtimePublication &&
            agentRevision.artifactDigest &&
            runtimeRevision.artifactDigest &&
            runtimePublication.conformanceRunId &&
            agentEvidenceValid &&
            runtimeEvidenceValid &&
            runtimeConformanceValid
              ? {
                  agentArtifactDigest: agentRevision.artifactDigest,
                  runtimeArtifactDigest: runtimeRevision.artifactDigest,
                  runtimeConfigDigest: runtimeRevision.configHash,
                  capabilityManifestDigest: computeCapabilityManifestDigest({
                    agentRevisionId: agentRevision.id,
                    agentInterfaceRequirements: agentRevision.agentInterfaceRequirementsJson,
                    runtimeRevisionId: runtimeRevision.id,
                    runtimeCapabilities: runtimeRevision.runtimeCapabilitiesJson,
                  }),
                  agentAttestationIds: [...agentPublication.attestationIds].sort(),
                  runtimeAttestationIds: [...runtimePublication.attestationIds].sort(),
                  agentPublicationRecordId: agentPublication.id,
                  runtimePublicationRecordId: runtimePublication.id,
                  conformanceRunId: runtimePublication.conformanceRunId,
                }
              : null;

          return {
            deploymentRouteId: route.id,
            routeSetId: routeSet.id,
            routeSetVersionNo: activation.routeSetVersionNo,
            routeRevisionId: revision.id,
            routeRevisionNo: revision.revisionNo,
            routeActivationId: activation.id,
            routeActivationSequence: activation.activationSequence,
            agentRevisionId: revision.agentRevisionId,
            runtimeRevisionId: revision.runtimeRevisionId,
            policyRevisionId: revision.policyRevisionId,
            contentDigest: revision.contentDigest,
            trafficWeight: revision.trafficWeight,
            routeGroupId: readRouteGroupId(revision.routeGroupId, revision.trafficAllocationJson, routeSet.id),
            priorityNo: revision.priorityNo,
            effectiveFrom: revision.effectiveFrom,
            effectiveUntil: revision.effectiveUntil,
            eligibilityConditions: revision.eligibilityConditionsJson,
            activationState: activation.activationState,
            agentLifecycleState: agent.lifecycleState,
            agentRevisionState: agentRevision.revisionState,
            agentPublicationActive: Boolean(agentPublication),
            agentEvidenceValid,
            runtimeLifecycleState: runtime.lifecycleState,
            runtimeRevisionState: runtimeRevision.revisionState,
            runtimePublicationActive: Boolean(runtimePublication),
            runtimeEvidenceValid,
            runtimeConformanceValid,
            policyRevisionState,
            controlPlaneEvidence,
          };
        }),
      );
      return candidates.filter((candidate): candidate is RouteResolutionCandidate =>
        Boolean(candidate),
      );
    }),
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadActivePublication(
  tx: Transaction,
  params: {
    tenantId: string;
    subjectType: "agent_revision" | "runtime_revision";
    subjectRevisionId: string;
  },
) {
  const [row] = await tx
    .select({ publication: publicationRecord, withdrawalId: withdrawalRecord.id })
    .from(publicationRecord)
    .leftJoin(withdrawalRecord, eq(withdrawalRecord.publicationRecordId, publicationRecord.id))
    .where(
      and(
        eq(publicationRecord.tenantId, params.tenantId),
        eq(publicationRecord.subjectType, params.subjectType),
        eq(publicationRecord.subjectRevisionId, params.subjectRevisionId),
      ),
    )
    .limit(1);
  return row && !row.withdrawalId ? row.publication : null;
}

async function validatePublicationEvidence(
  tx: Transaction,
  params: {
    tenantId: string;
    publication: typeof publicationRecord.$inferSelect | null;
    artifactType: "agent_revision" | "runtime_revision";
    revisionId: string;
    artifactId: string | null;
    artifactDigest: string | null;
  },
): Promise<boolean> {
  if (
    !params.publication ||
    !params.artifactId ||
    !params.artifactDigest ||
    !Array.isArray(params.publication.attestationIds) ||
    params.publication.attestationIds.length === 0
  ) {
    return false;
  }
  const results = await Promise.all(
    params.publication.attestationIds.map(async (attestationId) => {
      if (typeof attestationId !== "string") return false;
      const [row] = await tx
        .select({
          attestation: artifactAttestation,
          artifact,
          revocationId: attestationRevocationRecord.id,
        })
        .from(artifactAttestation)
        .innerJoin(artifact, eq(artifact.id, artifactAttestation.artifactId))
        .leftJoin(
          attestationRevocationRecord,
          eq(attestationRevocationRecord.attestationId, artifactAttestation.id),
        )
        .where(
          and(
            eq(artifactAttestation.id, attestationId),
            eq(artifactAttestation.tenantId, params.tenantId),
            eq(artifactAttestation.artifactType, params.artifactType),
            eq(artifactAttestation.artifactRevisionId, params.revisionId),
          ),
        )
        .limit(1);
      return Boolean(
        row &&
          !row.revocationId &&
          !row.attestation.revokedAt &&
          row.attestation.verificationState === "verified" &&
          row.attestation.artifactId === params.artifactId &&
          row.attestation.artifactDigest === params.artifactDigest &&
          row.artifact.tenantId === params.tenantId &&
          row.artifact.digest === params.artifactDigest,
      );
    }),
  );
  return results.every(Boolean);
}

async function validateRuntimeConformance(
  tx: Transaction,
  params: {
    tenantId: string;
    conformanceRunId: string | null;
    runtimeRevision: typeof runtimeRevisionTable.$inferSelect;
  },
): Promise<boolean> {
  if (!params.conformanceRunId || !params.runtimeRevision.artifactDigest) return false;
  const [run] = await tx
    .select()
    .from(runtimeConformanceRun)
    .where(
      and(
        eq(runtimeConformanceRun.id, params.conformanceRunId),
        eq(runtimeConformanceRun.tenantId, params.tenantId),
      ),
    )
    .limit(1);
  return Boolean(
    run &&
      run.overallResult === "passed" &&
      run.runtimeRevisionId === params.runtimeRevision.id &&
      run.runtimeArtifactDigest === params.runtimeRevision.artifactDigest &&
      run.runtimeConfigDigest === params.runtimeRevision.configHash &&
      run.protocolContractRevision === params.runtimeRevision.protocolContractRevision,
  );
}

/**
 * 读取 routeGroupId — 优先使用 RouteRevision 新列，回退到 trafficAllocationJson。
 *
 * 新列在 Migration 0117 后 nullable，Backfill 完成后 NOT NULL（0118）。
 * 此函数兼容两个阶段。
 */
function readRouteGroupId(columnValue: string | null, jsonValue: unknown, fallback: string): string {
  // 1. 优先使用新列（0118 后此值始终非 null）
  if (columnValue) return columnValue;
  // 2. 回退到 trafficAllocationJson.groupId（0117 后 Backfill 之前）
  if (jsonValue && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
    const groupId = (jsonValue as { groupId?: unknown }).groupId;
    if (typeof groupId === "string" && groupId.trim()) return groupId;
  }
  return fallback;
}
