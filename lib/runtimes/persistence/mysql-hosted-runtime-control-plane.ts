import { createHash, randomUUID } from "node:crypto";
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import {
  ArtifactAttestationFailedError,
  verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  getAttestationById,
  listAttestationsByRevision,
} from "@/lib/artifacts/persistence/artifact-attestation-queries";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { aiConfig, runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { agentRevisionTable, agentTable } from "@/lib/persistence/schema/control-plane";
import { deploymentRouteSetTable } from "@/lib/persistence/schema/control-plane";
import { tenantTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/control-plane";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { getWithdrawalRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { createActivateRouteRevision } from "@/lib/routes/application/activate-route-revision";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteControlStore } from "@/lib/routes/persistence/mysql-route-control-store";
import { mysqlRouteResolutionStore } from "@/lib/routes/persistence/mysql-route-resolution-store";
import type {
  HostedRuntimeControlPlane,
  HostedRuntimeRoute,
  PublishedHostedAgentRevision,
  PublishedHostedRuntimeRevision,
} from "@/lib/runtimes/application/provision-hosted-runtime";
import { createPublishRuntimeRevision } from "@/lib/runtimes/application/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import { ALL_CONFORMANCE_CASES } from "@/lib/runtimes/domain/runtime-conformance-contract";
import { getHostedControlPlaneEvidenceProvider } from "@/lib/runtimes/domain/hosted-control-plane-evidence";
import { protocolContractRevision } from "@/lib/runtimes/domain/runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtimes/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtimes/persistence/mysql-runtime-publication-store";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { and, desc, eq, max } from "drizzle-orm";

const BUILTIN_HOSTED_RUNTIME_KEY = "builtin-hosted";
const HOSTED_ACTOR_ID = "hosted-runtime-provisioner";
const HOSTED_SOURCE_REVISION = "builtin-hosted-release";
const HOSTED_RUNTIME_ENDPOINT = "in-process://hosted";
const HOSTED_RUNTIME_CAPABILITIES = {
  capabilities: ["event_stream"],
  limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
};
const HOSTED_RUNTIME_CONFIG_DIGEST = digest({
  protocolType: "in_process",
  endpointRef: HOSTED_RUNTIME_ENDPOINT,
  capabilities: HOSTED_RUNTIME_CAPABILITIES,
  identityMode: "managed",
  networkZone: "internal",
});

const recordArtifactAttestation = createRecordArtifactAttestation({
  store: mysqlArtifactAttestationPersistenceStore,
});
const publishAgentRevision = createPublishAgentRevision({ store: mysqlAgentPublicationStore });
const recordRuntimeConformanceRun = createRecordRuntimeConformanceRun({
  store: mysqlRuntimeConformanceRunStore,
  signingSecret: () => runtimeConformanceConfig.signingSecret,
});
const publishRuntimeRevision = createPublishRuntimeRevision({
  store: mysqlRuntimePublicationStore,
});
const activateRouteRevision = createActivateRouteRevision({ store: mysqlRouteControlStore });
const resolveRoute = createResolveRoute({ store: mysqlRouteResolutionStore });

export const mysqlHostedRuntimeControlPlane: HostedRuntimeControlPlane = {
  async resolveEligibleRoute(command) {
    const outcome = await resolveRoute({
      ...command,
      businessKey: { jobId: `hosted-provision:${command.agentId}` },
    });
    if (outcome.status !== "resolved") return null;
    if (
      !(await isBuiltinHostedRuntimeRevision(
        command.tenantId,
        outcome.resolution.runtimeRevisionId,
      ))
    ) {
      return null;
    }
    return {
      routeId: outcome.resolution.deploymentRouteId,
      routeRevisionId: outcome.resolution.routeRevisionId,
      routeActivationId: outcome.resolution.routeActivationId,
      agentRevisionId: outcome.resolution.agentRevisionId,
      runtimeRevisionId: outcome.resolution.runtimeRevisionId,
    };
  },

  async ensurePublishedAgentRevision(command) {
    const existing = await loadPublishedAgentRevision(command.tenantId, command.agentId);
    if (existing) return existing;

    const evidence = await getHostedControlPlaneEvidenceProvider().loadArtifactEvidence({
      tenantId: command.tenantId,
      artifactType: "agent_revision",
    });
    const { agent, revision } = await ensureAgentDraft({
      ...command,
      artifactRef: evidence.artifactRef,
    });
    if (revision.revisionState === "published") {
      const winner = await loadPublishedAgentRevision(command.tenantId, command.agentId);
      if (winner?.revisionId === revision.id) return winner;
      throw new Error("Hosted AgentRevision 当前指针缺少有效发布证据");
    }
    const attestation = await ensureVerifiedAttestation({
      tenantId: command.tenantId,
      artifactType: "agent_revision",
      artifactRevisionId: revision.id,
      evidence,
    });

    try {
      const result = await publishAgentRevision({
        tenantId: command.tenantId,
        revisionId: revision.id,
        agentExpectedVersionNo: agent.versionNo,
        attestationId: attestation.id,
        actor: { tenantId: command.tenantId, actorType: "system", actorId: HOSTED_ACTOR_ID },
        requestId: `hosted-agent-publish:${revision.id}`,
        idempotencyKey: `hosted-agent-publish:${revision.id}`,
      });
      return {
        revisionId: result.revision.id,
        publicationRecordId: result.publicationRecordId,
        attestationId: result.attestation.id,
      };
    } catch (error) {
      const winner = await loadPublishedAgentRevision(command.tenantId, command.agentId);
      if (winner?.revisionId === revision.id) return winner;
      throw error;
    }
  },

  async ensurePublishedRuntimeRevision(command) {
    const existing = await loadPublishedRuntimeRevision(command.tenantId);
    if (existing) return existing;

    const evidence = await getHostedControlPlaneEvidenceProvider().loadArtifactEvidence({
      tenantId: command.tenantId,
      artifactType: "runtime_revision",
    });
    const { runtime, revision } = await ensureRuntimeDraft({
      tenantId: command.tenantId,
      ownerUserId: await loadAgentOwner(command.tenantId, command.agentId),
      artifactRef: evidence.artifactRef,
    });
    if (revision.revisionState === "published") {
      const winner = await loadPublishedRuntimeRevision(command.tenantId);
      if (winner?.revisionId === revision.id) return winner;
      throw new Error("Hosted RuntimeRevision 当前指针缺少有效发布证据");
    }
    const attestation = await ensureVerifiedAttestation({
      tenantId: command.tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: revision.id,
      evidence,
    });
    const signedRun = await getHostedControlPlaneEvidenceProvider().runRuntimeConformance({
      tenantId: command.tenantId,
      runtimeRevisionId: revision.id,
      idempotencyKey: `hosted-runtime-conformance:${revision.id}`,
      runtimeArtifactDigest: attestation.artifactDigest,
      runtimeConfigDigest: revision.configHash,
      protocolContractRevision: revision.protocolContractRevision,
    });
    const run = await recordRuntimeConformanceRun({
      tenantId: command.tenantId,
      runtimeRevisionId: revision.id,
      report: signedRun.report,
      signature: signedRun.signature,
      idempotencyKey: `hosted-runtime-conformance:${revision.id}`,
      requestId: `hosted-runtime-conformance:${revision.id}`,
      actor: { actorType: "system", actorId: HOSTED_ACTOR_ID },
    });

    try {
      const result = await publishRuntimeRevision({
        tenantId: command.tenantId,
        revisionId: revision.id,
        runtimeExpectedVersionNo: runtime.versionNo,
        conformanceRunId: run.run.id,
        attestationId: attestation.id,
        actor: { tenantId: command.tenantId, actorType: "system", actorId: HOSTED_ACTOR_ID },
        requestId: `hosted-runtime-publish:${revision.id}`,
        idempotencyKey: `hosted-runtime-publish:${revision.id}`,
      });
      return {
        revisionId: result.revision.id,
        publicationRecordId: result.publicationRecordId,
        attestationId: result.attestation?.id ?? "",
        conformanceRunId: run.run.id,
      };
    } catch (error) {
      const winner = await loadPublishedRuntimeRevision(command.tenantId);
      if (winner?.revisionId === revision.id) return winner;
      throw error;
    }
  },

  async activateRoute(command) {
    const routeSet = await ensureRouteSet(command);
    await activateRouteRevision({
      tenantId: command.tenantId,
      routeSetId: routeSet.id,
      routeSetExpectedVersionNo: routeSet.versionNo,
      content: {
        agentRevisionId: command.agentRevision.revisionId,
        runtimeRevisionId: command.runtimeRevision.revisionId,
        policyRevisionId: null,
        modelPolicyRevisionId: null,
        toolsetRevisionId: null,
        trafficWeight: 10_000,
        priorityNo: 0,
        effectiveFrom: null,
        effectiveUntil: null,
        eligibilityConditions: {},
        routeGroupId: "primary",
      },
      actor: { tenantId: command.tenantId, actorType: "system", actorId: HOSTED_ACTOR_ID },
      reason: "激活内置 Hosted Runtime 正式路由",
      requestId: `hosted-route-activate:${command.agentId}`,
      idempotencyKey: [
        "hosted-route-activate",
        command.agentRevision.revisionId,
        command.runtimeRevision.revisionId,
      ].join(":"),
    });
  },
};

async function isBuiltinHostedRuntimeRevision(
  tenantId: string,
  runtimeRevisionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ runtimeId: runtimeTable.id })
    .from(runtimeRevisionTable)
    .innerJoin(
      runtimeTable,
      and(
        eq(runtimeTable.id, runtimeRevisionTable.runtimeId),
        eq(runtimeTable.tenantId, tenantId),
        eq(runtimeTable.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY),
        eq(runtimeTable.runtimeKind, "hosted"),
      ),
    )
    .where(eq(runtimeRevisionTable.id, runtimeRevisionId))
    .limit(1);
  return Boolean(row);
}

async function loadPublishedAgentRevision(
  tenantId: string,
  agentId: string,
): Promise<PublishedHostedAgentRevision | null> {
  const [agent] = await db
    .select()
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
    .limit(1);
  if (!agent?.currentRevisionId) return null;
  const [revision] = await db
    .select()
    .from(agentRevisionTable)
    .where(
      and(
        eq(agentRevisionTable.id, agent.currentRevisionId),
        eq(agentRevisionTable.agentId, agentId),
        eq(agentRevisionTable.revisionState, "published"),
      ),
    )
    .limit(1);
  if (!revision) return null;
  const fact = await loadPublicationFact({
    tenantId,
    subjectType: "agent_revision",
    revisionId: revision.id,
    artifactId: revision.artifactId,
    artifactDigest: revision.artifactDigest,
  });
  return fact ? { revisionId: revision.id, ...fact } : null;
}

async function loadPublishedRuntimeRevision(
  tenantId: string,
): Promise<PublishedHostedRuntimeRevision | null> {
  const [runtime] = await db
    .select()
    .from(runtimeTable)
    .where(
      and(
        eq(runtimeTable.tenantId, tenantId),
        eq(runtimeTable.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY),
      ),
    )
    .limit(1);
  if (!runtime?.currentRevisionId) return null;
  const [revision] = await db
    .select()
    .from(runtimeRevisionTable)
    .where(
      and(
        eq(runtimeRevisionTable.id, runtime.currentRevisionId),
        eq(runtimeRevisionTable.runtimeId, runtime.id),
        eq(runtimeRevisionTable.revisionState, "published"),
      ),
    )
    .limit(1);
  if (!revision) return null;
  const fact = await loadPublicationFact({
    tenantId,
    subjectType: "runtime_revision",
    revisionId: revision.id,
    artifactId: revision.artifactId,
    artifactDigest: revision.artifactDigest,
  });
  if (!fact?.conformanceRunId) return null;
  const [run] = await db
    .select()
    .from(runtimeConformanceRun)
    .where(
      and(
        eq(runtimeConformanceRun.id, fact.conformanceRunId),
        eq(runtimeConformanceRun.tenantId, tenantId),
        eq(runtimeConformanceRun.runtimeRevisionId, revision.id),
        eq(runtimeConformanceRun.overallResult, "passed"),
        eq(runtimeConformanceRun.runtimeArtifactDigest, revision.artifactDigest as string),
        eq(runtimeConformanceRun.runtimeConfigDigest, revision.configHash),
        eq(runtimeConformanceRun.protocolContractRevision, revision.protocolContractRevision),
      ),
    )
    .limit(1);
  if (!run) return null;
  const cases = await db
    .select()
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, run.id));
  if (cases.length !== ALL_CONFORMANCE_CASES.length || cases.some((item) => !item.passed)) return null;
  return { revisionId: revision.id, ...fact, conformanceRunId: fact.conformanceRunId };
}

async function loadPublicationFact(params: {
  tenantId: string;
  subjectType: "agent_revision" | "runtime_revision";
  revisionId: string;
  artifactId: string | null;
  artifactDigest: string | null;
}) {
  const [publication, withdrawal] = await Promise.all([
    getPublicationRecordBySubject({
      tenantId: params.tenantId,
      subjectType: params.subjectType,
      subjectRevisionId: params.revisionId,
    }),
    getWithdrawalRecordBySubject({
      tenantId: params.tenantId,
      subjectType: params.subjectType,
      subjectRevisionId: params.revisionId,
    }),
  ]);
  if (!publication || withdrawal || !params.artifactId || !params.artifactDigest) return null;
  const attestationId = publication.attestationIds[0];
  if (!attestationId) return null;
  const attestation = await getAttestationById(params.tenantId, attestationId);
  if (
    !attestation ||
    attestation.verificationState !== "verified" ||
    attestation.revokedAt ||
    attestation.artifactRevisionId !== params.revisionId ||
    attestation.artifactType !== params.subjectType ||
    attestation.artifactId !== params.artifactId ||
    attestation.artifactDigest !== params.artifactDigest
  ) {
    return null;
  }
  return {
    publicationRecordId: publication.id,
    attestationId,
    conformanceRunId: publication.conformanceRunId,
  };
}

async function ensureAgentDraft(params: {
  tenantId: string;
  agentId: string;
  artifactRef: string;
}) {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agentTable)
      .where(and(eq(agentTable.tenantId, params.tenantId), eq(agentTable.id, params.agentId)))
      .limit(1)
      .for("update");
    if (!agent) throw new Error(`Hosted Route 初始化失败：助手不存在 (${params.agentId})`);
    if (agent.currentRevisionId) {
      const [current] = await tx
        .select()
        .from(agentRevisionTable)
        .where(
          and(
            eq(agentRevisionTable.id, agent.currentRevisionId),
            eq(agentRevisionTable.agentId, agent.id),
            eq(agentRevisionTable.revisionState, "published"),
          ),
        )
        .limit(1);
      if (!current) throw new Error("Hosted AgentRevision 当前指针无效");
      return { agent, revision: current };
    }
    const [existing] = await tx
      .select()
      .from(agentRevisionTable)
      .where(
        and(
          eq(agentRevisionTable.agentId, agent.id),
          eq(agentRevisionTable.agentArtifactRef, params.artifactRef),
          eq(agentRevisionTable.revisionState, "draft"),
        ),
      )
      .orderBy(desc(agentRevisionTable.revisionNo))
      .limit(1);
    if (existing) return { agent, revision: existing };
    const [sequence] = await tx
      .select({ value: max(agentRevisionTable.revisionNo) })
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.agentId, agent.id));
    const id = randomUUID();
    await tx.insert(agentRevisionTable).values({
      id,
      agentId: agent.id,
      revisionNo: (sequence?.value ?? 0) + 1,
      sourceType: "code",
      sourceRevision: HOSTED_SOURCE_REVISION,
      instructionHash: digest("snow-harness:builtin-hosted-agent-instructions"),
      agentArtifactRef: params.artifactRef,
      modelPolicyJson: { default: aiConfig.chatModel, provider: "server-config" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
      revisionState: "draft",
      createdBy: agent.ownerUserId,
    });
    const [revision] = await tx
      .select()
      .from(agentRevisionTable)
      .where(eq(agentRevisionTable.id, id))
      .limit(1);
    if (!revision) throw new Error("Hosted AgentRevision 创建失败");
    return { agent, revision };
  });
}

async function ensureRuntimeDraft(params: {
  tenantId: string;
  ownerUserId: string;
  artifactRef: string;
}) {
  return db.transaction(async (tx) => {
    const [tenantRow] = await tx
      .select({ id: tenantTable.id })
      .from(tenantTable)
      .where(eq(tenantTable.id, params.tenantId))
      .limit(1)
      .for("update");
    if (!tenantRow) throw new Error(`Hosted Runtime 初始化失败：租户不存在 (${params.tenantId})`);
    let [runtime] = await tx
      .select()
      .from(runtimeTable)
      .where(
        and(
          eq(runtimeTable.tenantId, params.tenantId),
          eq(runtimeTable.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY),
        ),
      )
      .limit(1);
    if (!runtime) {
      const id = randomUUID();
      await tx.insert(runtimeTable).values({
        id,
        tenantId: params.tenantId,
        runtimeKey: BUILTIN_HOSTED_RUNTIME_KEY,
        displayName: "内置运行时",
        runtimeKind: "hosted",
        ownerUserId: params.ownerUserId,
        lifecycleState: "enabled",
      });
      [runtime] = await tx.select().from(runtimeTable).where(eq(runtimeTable.id, id)).limit(1);
    }
    if (!runtime) throw new Error("Hosted Runtime 创建失败");
    if (runtime.currentRevisionId) {
      const [current] = await tx
        .select()
        .from(runtimeRevisionTable)
        .where(
          and(
            eq(runtimeRevisionTable.id, runtime.currentRevisionId),
            eq(runtimeRevisionTable.runtimeId, runtime.id),
            eq(runtimeRevisionTable.revisionState, "published"),
          ),
        )
        .limit(1);
      if (!current) throw new Error("Hosted RuntimeRevision 当前指针无效");
      return { runtime, revision: current };
    }
    const [existing] = await tx
      .select()
      .from(runtimeRevisionTable)
      .where(
        and(
          eq(runtimeRevisionTable.runtimeId, runtime.id),
          eq(runtimeRevisionTable.runtimeArtifactRef, params.artifactRef),
          eq(runtimeRevisionTable.configHash, HOSTED_RUNTIME_CONFIG_DIGEST),
          eq(runtimeRevisionTable.revisionState, "draft"),
        ),
      )
      .orderBy(desc(runtimeRevisionTable.revisionNo))
      .limit(1);
    if (existing) return { runtime, revision: existing };
    const [sequence] = await tx
      .select({ value: max(runtimeRevisionTable.revisionNo) })
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.runtimeId, runtime.id));
    const id = randomUUID();
    await tx.insert(runtimeRevisionTable).values({
      id,
      runtimeId: runtime.id,
      revisionNo: (sequence?.value ?? 0) + 1,
      protocolType: "in_process",
      protocolContractRevision: protocolContractRevision("in_process"),
      endpointRef: HOSTED_RUNTIME_ENDPOINT,
      runtimeArtifactRef: params.artifactRef,
      runtimeCapabilitiesJson: HOSTED_RUNTIME_CAPABILITIES,
      identityMode: "managed",
      networkZone: "internal",
      configHash: HOSTED_RUNTIME_CONFIG_DIGEST,
      revisionState: "draft",
      createdBy: params.ownerUserId,
    });
    const [revision] = await tx
      .select()
      .from(runtimeRevisionTable)
      .where(eq(runtimeRevisionTable.id, id))
      .limit(1);
    if (!revision) throw new Error("Hosted RuntimeRevision 创建失败");
    return { runtime, revision };
  });
}

async function ensureVerifiedAttestation(params: {
  tenantId: string;
  artifactType: "agent_revision" | "runtime_revision";
  artifactRevisionId: string;
  evidence: Awaited<
    ReturnType<ReturnType<typeof getHostedControlPlaneEvidenceProvider>["loadArtifactEvidence"]>
  >;
}) {
  const existing = await listAttestationsByRevision(
    params.tenantId,
    params.artifactType,
    params.artifactRevisionId,
    { verificationState: "verified" },
  );
  const matching = existing.find(
    (item) =>
      item.artifactDigest === params.evidence.artifactDigest &&
      item.signatureBundleRef === params.evidence.signatureBundleRef &&
      !item.revokedAt,
  );
  if (matching) return matching;

  const verification = await verifyArtifactAttestation(
    {
      tenantId: params.tenantId,
      artifactType: params.artifactType,
      artifactRevisionId: params.artifactRevisionId,
      artifactDigest: params.evidence.artifactDigest,
      signatureBundleRef: params.evidence.signatureBundleRef,
      sbomRef: params.evidence.sbomRef,
      provenanceRef: params.evidence.provenanceRef,
      builderIdentity: params.evidence.builderIdentity,
    },
    params.evidence.managedStore,
    params.evidence.builderKeys,
  );
  const provenance = verification.provenanceSummary;
  let recorded: Awaited<ReturnType<typeof recordArtifactAttestation>>;
  try {
    recorded = await recordArtifactAttestation({
      tenantId: params.tenantId,
      artifactType: params.artifactType,
      artifactRevisionId: params.artifactRevisionId,
      artifactDigest: params.evidence.artifactDigest,
      signatureBundleRef: params.evidence.signatureBundleRef,
      sbomRef: params.evidence.sbomRef,
      provenanceRef: params.evidence.provenanceRef,
      builderIdentity: params.evidence.builderIdentity,
      verificationState: verification.verificationState,
      policyRevisionId: null,
      failureCode: verification.failureCode ?? null,
      verifiedAt: new Date(),
      sourceRevision: provenance?.sourceRevision ?? null,
      buildPipeline: provenance?.buildPipeline ?? null,
      dependencyLockFileHash: provenance?.dependencyLockFile ?? null,
      buildTime: provenance ? new Date(provenance.buildTime) : null,
      scanSummaryJson: verification.scanSummary ?? null,
      actor: { tenantId: params.tenantId, actorType: "system", actorId: HOSTED_ACTOR_ID },
      requestId: `hosted-attestation:${params.artifactRevisionId}`,
    });
  } catch (error) {
    const winner = (
      await listAttestationsByRevision(
        params.tenantId,
        params.artifactType,
        params.artifactRevisionId,
      )
    ).find(
      (item) =>
        item.artifactDigest === params.evidence.artifactDigest &&
        item.signatureBundleRef === params.evidence.signatureBundleRef &&
        item.verificationState === verification.verificationState &&
        !item.revokedAt,
    );
    if (!winner) throw error;
    recorded = winner;
  }
  if (verification.verificationState === "failed") {
    throw new ArtifactAttestationFailedError(
      verification.failureCode ?? "signature_invalid",
      `${verification.failureCode ?? "unknown"}: ${verification.failureReason ?? "Hosted 制品证明验证失败"}`,
    );
  }
  return recorded;
}

async function loadAgentOwner(tenantId: string, agentId: string): Promise<string> {
  const [agent] = await db
    .select({ ownerUserId: agentTable.ownerUserId })
    .from(agentTable)
    .where(and(eq(agentTable.tenantId, tenantId), eq(agentTable.id, agentId)))
    .limit(1);
  if (!agent) throw new Error(`Hosted Route 初始化失败：助手不存在 (${agentId})`);
  return agent.ownerUserId;
}

async function ensureRouteSet(command: {
  tenantId: string;
  agentId: string;
  routeScopeKey: string;
}) {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(and(eq(agentTable.tenantId, command.tenantId), eq(agentTable.id, command.agentId)))
      .limit(1)
      .for("update");
    if (!agent) throw new Error(`Hosted Route 初始化失败：助手不存在 (${command.agentId})`);
    const [existing] = await tx
      .select()
      .from(deploymentRouteSetTable)
      .where(
        and(
          eq(deploymentRouteSetTable.tenantId, command.tenantId),
          eq(deploymentRouteSetTable.agentId, command.agentId),
          eq(deploymentRouteSetTable.routeScopeKey, command.routeScopeKey),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const id = randomUUID();
    await tx.insert(deploymentRouteSetTable).values({
      id,
      tenantId: command.tenantId,
      agentId: command.agentId,
      routeScopeKey: command.routeScopeKey,
      routeScopeJson: { runtime: BUILTIN_HOSTED_RUNTIME_KEY },
      versionNo: 1,
    });
    const [created] = await tx
      .select()
      .from(deploymentRouteSetTable)
      .where(eq(deploymentRouteSetTable.id, id))
      .limit(1);
    if (!created) throw new Error("Hosted RouteSet 创建失败");
    return created;
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
