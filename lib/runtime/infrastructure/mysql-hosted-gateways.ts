/**
 * MySQL Hosted Gateways 实现 — 纯适配器层。
 *
 * Runtime-only Authority：
 * 将 mysql-hosted-runtime-control-plane.ts 单体拆分为职责清晰的 Gateway，
 * 每个 Gateway 只做 DB 访问 + 对应领域调用。Saga 负责步骤编排；此文件只提供基础设施适配。
 *
 * 本文件只供应 tenant 内 builtin Harness Runtime 及其 targetKind=runtime Route。
 * 无 Agent 发布、Agent revision、Agent route，或 builtin-runtime binding 检查。
 * runtimePrepare 使用 requesterId 作为首次创建 Runtime 记录 owner，不查询 Agent。
 *
 * 事实源：docs/architecture/agent-control-plane.md 与 docs/architecture/persistence.md。
 */

import { createHash, randomUUID } from "node:crypto";
import { createRecordArtifactAttestation } from "@/lib/artifacts/application/record-artifact-attestation";
import {
  ArtifactAttestationFailedError,
  verifyArtifactAttestation,
} from "@/lib/artifacts/domain/artifact-attestation";
import { listAttestationsByRevision } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { mysqlArtifactAttestationPersistenceStore } from "@/lib/artifacts/persistence/mysql-artifact-attestation-store";
import { runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { tenantTable } from "@/lib/persistence/schema/control-plane";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { ensureRouteSetByTargetScope } from "@/lib/routes/application/deployment-route-service";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { getHostedControlPlaneEvidenceProvider } from "@/lib/runtime/domain/hosted-control-plane-evidence";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import { computeRuntimeTargetDigest } from "@/lib/runtime/domain/runtime-target-digest";
import type {
  HostedGateways,
  HostedRuntimeArtifactVerifyGateway,
  HostedRuntimeConformanceGateway,
  HostedRuntimePrepareGateway,
  HostedRuntimePublishGateway,
  HostedRuntimeRouteActivationGateway,
  HostedRuntimeRouteReader,
} from "@/lib/runtime/infrastructure/hosted-gateways";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import type { HostedRuntimeRoute } from "@/lib/runtime/provisioning/provision-hosted-runtime";
import { createPublishRuntimeRevision } from "@/lib/runtime/provisioning/publish-runtime-revision";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { and, desc, eq, max } from "drizzle-orm";

// ─── Runner Identity Registry 构建 ──────────────────────────

/**
 * 从配置构建 RunnerSigningIdentityRegistry。
 *
 * 仅使用 SNOW_RUNNER_SIGNING_IDENTITIES_JSON；缺失或非法时为空并 fail-closed。
 */
function buildRunnerIdentityRegistry(): RunnerSigningIdentityRegistry {
  return new RunnerSigningIdentityRegistry(runtimeConformanceConfig.runnerSigningIdentities);
}

// ─── 常量 ───────────────────────────────────────────────────

const BUILTIN_HOSTED_RUNTIME_KEY = "builtin-hosted";
const HOSTED_ACTOR_ID = "hosted-runtime-provisioner";
const HOSTED_RUNTIME_ENDPOINT = "in-process://hosted";
// runtimeCapabilitiesJson 的权威契约是 string[]（能力名列表）。
// hosted runtime 声明 event_stream 能力；执行限额（600s / 1MB）由
// dispatcher/redispatch 的默认值承载，二者数值一致，故不在此对象承载。
const HOSTED_RUNTIME_CAPABILITIES = ["event_stream"];
/**
 * Hosted in-process 协议契约版本 — 显式冻结，不再从 protocolType 自动推导。
 */
const HOSTED_PROTOCOL_CONTRACT_REVISION = "harness-runtime-protocol@1";
const HOSTED_RUNTIME_CONFIG_DIGEST = digest({
  protocolType: "in_process",
  endpointRef: HOSTED_RUNTIME_ENDPOINT,
  capabilities: HOSTED_RUNTIME_CAPABILITIES,
  identityMode: "managed",
  networkZone: "internal",
});

// ─── 领域服务单例 ───────────────────────────────────────────

const recordArtifactAttestation = createRecordArtifactAttestation({
  store: mysqlArtifactAttestationPersistenceStore,
});
const publishRuntimeRevision = createPublishRuntimeRevision({
  store: mysqlRuntimePublicationStore,
});
const resolveRoute = createResolveRoute({ store: mysqlRouteEligibilityResolutionStore });
const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

// ─── 1. HostedRuntimeRouteReader ───────────────────────────

const runtimeRouteReader: HostedRuntimeRouteReader = {
  async resolveEligibleRuntimeRoute(command) {
    const outcome = await resolveRoute({
      tenantId: command.tenantId,
      // 显式 runtime target：解析 targetKind=runtime Route（Agent 与 Runtime Authority 分离）。
      target: { kind: "runtime" },
      routeScopeKey: command.routeScopeKey,
      businessKey: { jobId: `hosted-provision:${command.routeScopeKey}` },
    });
    if (outcome.status !== "resolved") return null;
    const resolution = outcome.resolution;
    // 从 resolution.target 读取 runtimeRevisionId（判别联合，无扁平旧字段）。
    if (resolution.target.kind !== "runtime") return null;
    return {
      routeId: resolution.deploymentRouteId,
      routeRevisionId: resolution.routeRevisionId,
      routeActivationId: resolution.routeActivationId,
      runtimeRevisionId: resolution.target.runtimeRevisionId,
      projectionVersionNo: resolution.projectionVersionNo,
    };
  },
};

// ─── 2. Runtime Step Gateways ─────────────────────────

/** prepareRuntimeRevision — 命令只含 {tenantId, requesterId}。 */
const runtimePrepare: HostedRuntimePrepareGateway = {
  async prepareRuntimeRevision(command) {
    const evidence = await getHostedControlPlaneEvidenceProvider().loadArtifactEvidence({
      tenantId: command.tenantId,
      artifactType: "runtime_revision",
    });
    const { runtime, revision } = await ensureRuntimeDraft({
      tenantId: command.tenantId,
      // requesterId 仅作为首次创建 Runtime 记录 owner；不查询 Agent/AgentRevision。
      ownerUserId: command.requesterId,
      artifactRef: evidence.artifactRef,
      artifactDigest: evidence.artifactDigest,
    });
    return { runtimeId: runtime.id, runtimeRevisionId: revision.id };
  },
};

/** verifyRuntimeArtifact */
const runtimeArtifactVerify: HostedRuntimeArtifactVerifyGateway = {
  async verifyRuntimeArtifact(command) {
    const evidence = await getHostedControlPlaneEvidenceProvider().loadArtifactEvidence({
      tenantId: command.tenantId,
      artifactType: "runtime_revision",
    });
    const attestation = await ensureVerifiedAttestation({
      tenantId: command.tenantId,
      artifactType: "runtime_revision",
      artifactRevisionId: command.runtimeRevisionId,
      evidence,
    });
    if (!attestation.artifactId?.trim()) {
      throw new Error(`Runtime Attestation 缺少 artifactId (${attestation.id})`);
    }
    return {
      runtimeArtifactId: attestation.artifactId,
      runtimeAttestationIds: [attestation.id],
    };
  },
};

/** recordRuntimeConformance */
function createRuntimeConformanceGateway(
  recordRuntimeConformanceRun: ReturnType<typeof createRecordRuntimeConformanceRun>,
): HostedRuntimeConformanceGateway {
  return {
    async recordRuntimeConformance(command) {
      const [revision] = await db
        .select({
          configHash: runtimeRevisionTable.configHash,
          protocolContractRevision: runtimeRevisionTable.protocolContractRevision,
          runtimeTargetDigest: runtimeRevisionTable.runtimeTargetDigest,
        })
        .from(runtimeRevisionTable)
        .where(eq(runtimeRevisionTable.id, command.runtimeRevisionId))
        .limit(1);
      if (!revision) throw new Error(`RuntimeRevision 不存在 (${command.runtimeRevisionId})`);

      const signedRun = await getHostedControlPlaneEvidenceProvider().runRuntimeConformance({
        tenantId: command.tenantId,
        runtimeRevisionId: command.runtimeRevisionId,
        idempotencyKey: `hosted-runtime-conformance:${command.runtimeRevisionId}`,
        runtimeTargetDigest: revision.runtimeTargetDigest,
        runtimeConfigDigest: revision.configHash,
        protocolContractRevision: revision.protocolContractRevision,
      });
      const run = await recordRuntimeConformanceRun({
        tenantId: command.tenantId,
        runtimeRevisionId: command.runtimeRevisionId,
        dsseEnvelope: signedRun.dsseEnvelope,
        idempotencyKey: `hosted-runtime-conformance:${command.runtimeRevisionId}`,
        requestId: `hosted-runtime-conformance:${command.runtimeRevisionId}`,
        actor: { actorType: "system", actorId: HOSTED_ACTOR_ID },
      });
      return {
        conformanceRunId: run.run.id,
        overallResult: run.run.overallResult as "passed" | "failed",
      };
    },
  };
}

/** publishRuntimeRevision */
const runtimePublish: HostedRuntimePublishGateway = {
  async publishRuntimeRevision(command) {
    const attestationId = command.runtimeAttestationIds[0]?.trim();
    if (!command.conformanceRunId.trim() || !attestationId) {
      throw new Error("发布 Hosted RuntimeRevision 缺少 Conformance 或 Attestation 事实");
    }
    const [runtime] = await db
      .select()
      .from(runtimeTable)
      .where(
        and(
          eq(runtimeTable.tenantId, command.tenantId),
          eq(runtimeTable.runtimeKey, BUILTIN_HOSTED_RUNTIME_KEY),
        ),
      )
      .limit(1);
    if (!runtime) throw new Error("Hosted Runtime 不存在");

    const result = await publishRuntimeRevision({
      tenantId: command.tenantId,
      revisionId: command.runtimeRevisionId,
      runtimeExpectedVersionNo: runtime.versionNo,
      conformanceRunId: command.conformanceRunId,
      attestationId,
      actor: { tenantId: command.tenantId, actorType: "system", actorId: HOSTED_ACTOR_ID },
      requestId: `hosted-runtime-publish:${command.runtimeRevisionId}`,
      idempotencyKey: `hosted-runtime-publish:${command.runtimeRevisionId}`,
    });
    return { runtimePublicationRecordId: result.publicationRecordId };
  },
};

// ─── 3. HostedRuntimeRouteActivationGateway ─────────────────
//
// 使用 ActivateRouteSet 原子激活整个 RouteSet。
// 先 ensureRouteSetByTargetScope（targetKind=runtime），
// 再 activateRouteSet with desiredRoutes 含一条 active runtime 路由。
// 不接受任何 Agent endpoint/identity/credential/network 字段。

const runtimeRouteActivation: HostedRuntimeRouteActivationGateway = {
  async activateRuntimeRoute(command) {
    const { routeSet } = await ensureRouteSetByTargetScope({
      tenantId: command.tenantId,
      target: { kind: "runtime" },
      routeScopeKey: command.routeScopeKey,
      routeScopeJson: { runtimeKey: BUILTIN_HOSTED_RUNTIME_KEY },
    });
    const activated = await activateRouteSet({
      tenantId: command.tenantId,
      routeSetId: routeSet.id,
      expectedVersionNo: routeSet.versionNo,
      desiredRoutes: [
        {
          routeKey: "primary",
          target: {
            kind: "runtime",
            runtimeRevisionId: command.runtimeRevision.revisionId,
          },
          policyRevisionId: null,
          modelPolicyRevisionId: null,
          toolsetRevisionId: null,
          trafficWeight: 10_000,
          priorityNo: 0,
          effectiveFrom: null,
          effectiveUntil: null,
          eligibilityConditions: {},
          routeGroupId: "primary",
          activationState: "active",
        },
      ],
      actor: { tenantId: command.tenantId, actorType: "system", actorId: HOSTED_ACTOR_ID },
      reason: "激活内置 Hosted Runtime 正式路由",
      requestId: `hosted-route-activate:${command.routeScopeKey}:${command.runtimeRevision.revisionId}`,
      idempotencyKey: [
        "hosted-route-activate",
        command.routeScopeKey,
        command.runtimeRevision.revisionId,
      ].join(":"),
    });

    const activation = activated.activations[0];
    if (!activation) {
      throw new Error("Hosted Runtime Route 激活未返回 Activation 事实");
    }
    // 返回路由详情
    return {
      routeSetId: activated.routeSetId,
      routeSetVersionNo: activated.routeSetVersionNo,
      routeId: activation.routeId,
      routeRevisionId: activation.routeRevisionId,
      routeActivationId: activation.routeActivationId,
    };
  },
};

// ─── 5. HostedArtifactEvidenceProvider ──────────────────────
//

// ─── 6. HostedConformanceRunner ─────────────────────────────
//

// ─── 工厂函数 ──────────────────────────────────────────────

/**
 * 创建 MySQL Hosted Gateways 实例。
 * 返回 6 个 runtime-only Gateway 的组合对象，供 Saga 编排使用。
 */
export interface MysqlHostedGatewaysDependencies {
  runnerSigningIdentityRegistry?: RunnerSigningIdentityRegistry;
}

export function createMysqlHostedGateways(
  dependencies: MysqlHostedGatewaysDependencies = {},
): HostedGateways {
  const recordRuntimeConformanceRun = createRecordRuntimeConformanceRun({
    store: mysqlRuntimeConformanceRunStore,
    verifier: createDSSEConformanceVerifier({
      runnerIdentityRegistry:
        dependencies.runnerSigningIdentityRegistry ?? buildRunnerIdentityRegistry(),
    }),
  });
  return {
    runtimeRouteReader,
    runtimePrepare,
    runtimeArtifactVerify,
    runtimeConformance: createRuntimeConformanceGateway(recordRuntimeConformanceRun),
    runtimePublish,
    runtimeRouteActivation,
  };
}

// ─── 内部辅助函数 ──────────────────────────────────────────
// (从 mysql-hosted-runtime-control-plane.ts 搬运，逻辑不变)

async function ensureRuntimeDraft(params: {
  tenantId: string;
  ownerUserId: string;
  artifactRef: string;
  /** 与 artifactRef 同时冻结的受管 Artifact digest（hosted_artifact 证据必填，03 §3）。 */
  artifactDigest: string;
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
      protocolContractRevision: HOSTED_PROTOCOL_CONTRACT_REVISION,
      runtimeEvidenceKind: "hosted_artifact",
      runtimeTargetDigest: computeRuntimeTargetDigest({
        runtimeEvidenceKind: "hosted_artifact",
        runtimeArtifactDigest: params.artifactDigest,
        runtimeConfigDigest: HOSTED_RUNTIME_CONFIG_DIGEST,
        protocolContractRevision: HOSTED_PROTOCOL_CONTRACT_REVISION,
      }),
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
  artifactType: "runtime_revision";
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
    ({ attestation, revocation }) =>
      attestation.artifactDigest === params.evidence.artifactDigest &&
      attestation.dsseEnvelopeRef === params.evidence.dsseEnvelopeRef &&
      !revocation,
  );
  if (matching) return matching.attestation;

  const verification = await verifyArtifactAttestation(
    {
      tenantId: params.tenantId,
      artifactType: params.artifactType,
      artifactRevisionId: params.artifactRevisionId,
      artifactDigest: params.evidence.artifactDigest,
      dsseEnvelopeRef: params.evidence.dsseEnvelopeRef,
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
      dsseEnvelopeRef: params.evidence.dsseEnvelopeRef,
      sbomRef: verification.sbomRef ?? "",
      provenanceRef: verification.provenanceRef ?? "",
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
      ({ attestation, revocation }) =>
        attestation.artifactDigest === params.evidence.artifactDigest &&
        attestation.dsseEnvelopeRef === params.evidence.dsseEnvelopeRef &&
        attestation.verificationState === verification.verificationState &&
        !revocation,
    );
    if (!winner) throw error;
    recorded = winner.attestation;
  }
  if (verification.verificationState === "failed") {
    throw new ArtifactAttestationFailedError(
      verification.failureCode ?? "signature_invalid",
      `${verification.failureCode ?? "unknown"}: ${verification.failureReason ?? "Hosted 制品证明验证失败"}`,
    );
  }
  return recorded;
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
