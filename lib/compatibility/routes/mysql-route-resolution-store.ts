import {
  artifact,
  artifactAttestation,
  attestationRevocationRecord,
} from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
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
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { v11DeploymentRoute, v11DeploymentRouteSet } from "@/lib/v11/schema/deployment-route";
import { v11PolicyRevision } from "@/lib/v11/schema/permission";
import { v11Runtime, v11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { and, desc, eq, isNull } from "drizzle-orm";

export const mysqlRouteResolutionStore: RouteResolutionStore = {
  loadCandidates: (input) =>
    db.transaction(async (tx) => {
      const [routeSet] = await tx
        .select()
        .from(v11DeploymentRouteSet)
        .where(
          and(
            eq(v11DeploymentRouteSet.tenantId, input.tenantId),
            eq(v11DeploymentRouteSet.agentId, input.agentId),
            eq(v11DeploymentRouteSet.routeScopeKey, input.routeScopeKey),
          ),
        )
        .limit(1);
      if (!routeSet) return [];

      const routes = await tx
        .select()
        .from(v11DeploymentRoute)
        .where(eq(v11DeploymentRoute.routeSetId, routeSet.id));
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
              .from(v11Agent)
              .where(
                and(
                  eq(v11Agent.tenantId, input.tenantId),
                  eq(v11Agent.id, routeSet.agentId),
                  isNull(v11Agent.deletedAt),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(v11AgentRevision)
              .where(
                and(
                  eq(v11AgentRevision.id, revision.agentRevisionId),
                  eq(v11AgentRevision.agentId, routeSet.agentId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(v11RuntimeRevision)
              .where(eq(v11RuntimeRevision.id, revision.runtimeRevisionId))
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (!agent || !agentRevision || !runtimeRevision) return null;
          const [runtime] = await tx
            .select()
            .from(v11Runtime)
            .where(
              and(
                eq(v11Runtime.tenantId, input.tenantId),
                eq(v11Runtime.id, runtimeRevision.runtimeId),
                isNull(v11Runtime.deletedAt),
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
                .select({ state: v11PolicyRevision.revisionState })
                .from(v11PolicyRevision)
                .where(eq(v11PolicyRevision.id, revision.policyRevisionId))
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
            routeGroupId: readRouteGroupId(revision.trafficAllocationJson, routeSet.id),
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
    runtimeRevision: typeof v11RuntimeRevision.$inferSelect;
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

function readRouteGroupId(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const groupId = (value as { groupId?: unknown }).groupId;
    if (typeof groupId === "string" && groupId.trim()) return groupId;
  }
  return fallback;
}
