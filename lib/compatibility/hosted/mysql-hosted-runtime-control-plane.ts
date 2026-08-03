import { createHash, randomUUID } from "node:crypto";
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import {
  ArtifactAttestationFailedError,
  verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/compatibility/artifacts/mysql-artifact-attestation-store";
import { mysqlRouteControlStore } from "@/lib/compatibility/routes/mysql-route-control-store";
import { mysqlRouteResolutionStore } from "@/lib/compatibility/routes/mysql-route-resolution-store";
import { mysqlRuntimeConformanceRunStore } from "@/lib/compatibility/runtimes/mysql-runtime-conformance-run-store";
import { aiConfig, runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { getWithdrawalRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import { createActivateRouteRevision } from "@/lib/routes/application/activate-route-revision";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import type {
  HostedRuntimeControlPlane,
  HostedRuntimeRoute,
  PublishedHostedAgentRevision,
  PublishedHostedRuntimeRevision,
} from "@/lib/runtimes/application/provision-hosted-runtime";
import { createPublishRuntimeRevision } from "@/lib/runtimes/application/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import { protocolContractRevision } from "@/lib/runtimes/domain/runtime-conformance-run";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import {
  getAttestationById,
  listAttestationsByRevision,
} from "@/lib/v11/control-plane/artifact-attestation-queries";
import { mysqlAgentPublicationStore } from "@/lib/v11/control-plane/mysql-agent-publication-store";
import { mysqlRuntimePublicationStore } from "@/lib/v11/control-plane/mysql-runtime-publication-store";
import { v11Agent, v11AgentRevision } from "@/lib/v11/schema/agent";
import { v11DeploymentRouteSet } from "@/lib/v11/schema/deployment-route";
import { tenant } from "@/lib/v11/schema/identity";
import { v11Runtime, v11RuntimeRevision } from "@/lib/v11/schema/runtime";
import { and, desc, eq, max } from "drizzle-orm";
import { getHostedControlPlaneEvidenceProvider } from "./hosted-control-plane-evidence";

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
    .select({ runtimeId: v11Runtime.id })
    .from(v11RuntimeRevision)
    .innerJoin(
      v11Runtime,
      and(
        eq(v11Runtime.id, v11RuntimeRevision.runtimeId),
        eq(v11Runtime.tenantId, tenantId),
        eq(v11Runtime.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY),
        eq(v11Runtime.runtimeKind, "hosted"),
      ),
    )
    .where(eq(v11RuntimeRevision.id, runtimeRevisionId))
    .limit(1);
  return Boolean(row);
}

async function loadPublishedAgentRevision(
  tenantId: string,
  agentId: string,
): Promise<PublishedHostedAgentRevision | null> {
  const [agent] = await db
    .select()
    .from(v11Agent)
    .where(and(eq(v11Agent.tenantId, tenantId), eq(v11Agent.id, agentId)))
    .limit(1);
  if (!agent?.currentRevisionId) return null;
  const [revision] = await db
    .select()
    .from(v11AgentRevision)
    .where(
      and(
        eq(v11AgentRevision.id, agent.currentRevisionId),
        eq(v11AgentRevision.agentId, agentId),
        eq(v11AgentRevision.revisionState, "published"),
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
    .from(v11Runtime)
    .where(
      and(eq(v11Runtime.tenantId, tenantId), eq(v11Runtime.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY)),
    )
    .limit(1);
  if (!runtime?.currentRevisionId) return null;
  const [revision] = await db
    .select()
    .from(v11RuntimeRevision)
    .where(
      and(
        eq(v11RuntimeRevision.id, runtime.currentRevisionId),
        eq(v11RuntimeRevision.runtimeId, runtime.id),
        eq(v11RuntimeRevision.revisionState, "published"),
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
  if (cases.length !== 16 || cases.some((item) => !item.passed)) return null;
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
      .from(v11Agent)
      .where(and(eq(v11Agent.tenantId, params.tenantId), eq(v11Agent.id, params.agentId)))
      .limit(1)
      .for("update");
    if (!agent) throw new Error(`Hosted Route 初始化失败：助手不存在 (${params.agentId})`);
    if (agent.currentRevisionId) {
      const [current] = await tx
        .select()
        .from(v11AgentRevision)
        .where(
          and(
            eq(v11AgentRevision.id, agent.currentRevisionId),
            eq(v11AgentRevision.agentId, agent.id),
            eq(v11AgentRevision.revisionState, "published"),
          ),
        )
        .limit(1);
      if (!current) throw new Error("Hosted AgentRevision 当前指针无效");
      return { agent, revision: current };
    }
    const [existing] = await tx
      .select()
      .from(v11AgentRevision)
      .where(
        and(
          eq(v11AgentRevision.agentId, agent.id),
          eq(v11AgentRevision.agentArtifactRef, params.artifactRef),
          eq(v11AgentRevision.revisionState, "draft"),
        ),
      )
      .orderBy(desc(v11AgentRevision.revisionNo))
      .limit(1);
    if (existing) return { agent, revision: existing };
    const [sequence] = await tx
      .select({ value: max(v11AgentRevision.revisionNo) })
      .from(v11AgentRevision)
      .where(eq(v11AgentRevision.agentId, agent.id));
    const id = randomUUID();
    await tx.insert(v11AgentRevision).values({
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
      .from(v11AgentRevision)
      .where(eq(v11AgentRevision.id, id))
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
      .select({ id: tenant.id })
      .from(tenant)
      .where(eq(tenant.id, params.tenantId))
      .limit(1)
      .for("update");
    if (!tenantRow) throw new Error(`Hosted Runtime 初始化失败：租户不存在 (${params.tenantId})`);
    let [runtime] = await tx
      .select()
      .from(v11Runtime)
      .where(
        and(
          eq(v11Runtime.tenantId, params.tenantId),
          eq(v11Runtime.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY),
        ),
      )
      .limit(1);
    if (!runtime) {
      const id = randomUUID();
      await tx.insert(v11Runtime).values({
        id,
        tenantId: params.tenantId,
        runtimeKey: BUILTIN_HOSTED_RUNTIME_KEY,
        displayName: "内置运行时",
        runtimeKind: "hosted",
        ownerUserId: params.ownerUserId,
        lifecycleState: "enabled",
      });
      [runtime] = await tx.select().from(v11Runtime).where(eq(v11Runtime.id, id)).limit(1);
    }
    if (!runtime) throw new Error("Hosted Runtime 创建失败");
    if (runtime.currentRevisionId) {
      const [current] = await tx
        .select()
        .from(v11RuntimeRevision)
        .where(
          and(
            eq(v11RuntimeRevision.id, runtime.currentRevisionId),
            eq(v11RuntimeRevision.runtimeId, runtime.id),
            eq(v11RuntimeRevision.revisionState, "published"),
          ),
        )
        .limit(1);
      if (!current) throw new Error("Hosted RuntimeRevision 当前指针无效");
      return { runtime, revision: current };
    }
    const [existing] = await tx
      .select()
      .from(v11RuntimeRevision)
      .where(
        and(
          eq(v11RuntimeRevision.runtimeId, runtime.id),
          eq(v11RuntimeRevision.runtimeArtifactRef, params.artifactRef),
          eq(v11RuntimeRevision.configHash, HOSTED_RUNTIME_CONFIG_DIGEST),
          eq(v11RuntimeRevision.revisionState, "draft"),
        ),
      )
      .orderBy(desc(v11RuntimeRevision.revisionNo))
      .limit(1);
    if (existing) return { runtime, revision: existing };
    const [sequence] = await tx
      .select({ value: max(v11RuntimeRevision.revisionNo) })
      .from(v11RuntimeRevision)
      .where(eq(v11RuntimeRevision.runtimeId, runtime.id));
    const id = randomUUID();
    await tx.insert(v11RuntimeRevision).values({
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
      .from(v11RuntimeRevision)
      .where(eq(v11RuntimeRevision.id, id))
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
    .select({ ownerUserId: v11Agent.ownerUserId })
    .from(v11Agent)
    .where(and(eq(v11Agent.tenantId, tenantId), eq(v11Agent.id, agentId)))
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
      .select({ id: v11Agent.id })
      .from(v11Agent)
      .where(and(eq(v11Agent.tenantId, command.tenantId), eq(v11Agent.id, command.agentId)))
      .limit(1)
      .for("update");
    if (!agent) throw new Error(`Hosted Route 初始化失败：助手不存在 (${command.agentId})`);
    const [existing] = await tx
      .select()
      .from(v11DeploymentRouteSet)
      .where(
        and(
          eq(v11DeploymentRouteSet.tenantId, command.tenantId),
          eq(v11DeploymentRouteSet.agentId, command.agentId),
          eq(v11DeploymentRouteSet.routeScopeKey, command.routeScopeKey),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const id = randomUUID();
    await tx.insert(v11DeploymentRouteSet).values({
      id,
      tenantId: command.tenantId,
      agentId: command.agentId,
      routeScopeKey: command.routeScopeKey,
      routeScopeJson: { runtime: BUILTIN_HOSTED_RUNTIME_KEY },
      versionNo: 1,
    });
    const [created] = await tx
      .select()
      .from(v11DeploymentRouteSet)
      .where(eq(v11DeploymentRouteSet.id, id))
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
