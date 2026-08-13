/**
 * 正式 Turn 调度的可复用测试夹具（真实 MySQL 8）。
 *
 * 从一个 resetDatabase 后的空库，幂等建出可被 `dispatchEmployeeTurn` 真正调度的
 * 完整上下文：Tenant → UserIdentity → principalBinding → enabled Agent →
 * published AgentRevision（artifact+attestation）→ hosted Runtime →
 * published RuntimeRevision（conformance）→ RouteSet → RouteActivation →
 * RouteEligibilityProjection → Thread → accepted Turn。
 *
 * §27"测试必须证明生产链"：turn 调度测试必须走真实 Route Resolver →
 * ExecutionBinding → Runtime，而不是 mock 成功。本夹具即为此而建。
 *
 * owner 默认用 DEFAULT_USER_ID 身份，使 SNOW_AUTH_MODE=dev 下路由解析出的
 * principal 与 thread 属主一致（conversation 路由按属主鉴权）。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agent";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtime";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishTrustedAgentRevisionForTest } from "@/lib/test-support/publish-trusted-agent-revision";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/test-support/publish-trusted-runtime-revision";

export const DEFAULT_ROUTE_SCOPE_KEY = "default";

// ─── InMemoryManagedArtifactStore ────────────────────────────

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private envelopes = new Map<string, Buffer>();
  private sboms = new Map<string, unknown>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeDsseEnvelope(ref: string, envelope: Buffer): void {
    this.envelopes.set(ref, envelope);
  }
  writeSbom(ref: string, doc: unknown): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const envelope = this.envelopes.get(ref);
    if (!envelope) throw new Error(`DSSE envelope not found: ${ref}`);
    return envelope;
  }
  async readSbom(ref: string): Promise<unknown> {
    const doc = this.sboms.get(ref);
    if (!doc) throw new Error(`sbom not found: ${ref}`);
    return doc;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const doc = this.provenances.get(ref);
    if (!doc) throw new Error(`provenance not found: ${ref}`);
    return doc;
  }
}

// ─── 辅助构造 ────────────────────────────────────────────────

function buildCleanSbom(): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    sourceRevision: "git:abc123def456",
    buildPipeline: "ci-cd-pipeline-1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

async function createVerifiedAttestation(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
) {
  const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, {
      sbomRef,
      sbomContent: buildCleanSbom(),
      provenanceRef: provRef,
      provenanceContent: buildValidProvenance(),
    }),
  );
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:company-agent-runtime",
  };

  return verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );
}

// ─── seed 租户 + 默认用户 ────────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

// ─── seed Agent + published AgentRevision ────────────────────

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  requiredCaps: string[],
  contentSuffix: string,
  modelPolicy?: Record<string, unknown>,
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: `git:${contentSuffix}`,
    instructionHash: `sha256:instruction_${contentSuffix}`,
    agentArtifactRef: `oci://registry/agent@sha256:${contentSuffix}`,
    modelPolicyJson: modelPolicy ?? { default: "doubao-pro", provider: "doubao" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: requiredCaps, optional: [] },
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${contentSuffix}`,
  );
  await publishTrustedAgentRevisionForTest({
    tenantId,
    revisionId: revision.id,
    agentExpectedVersionNo: 1,
    attestationId: attestation.id,
    actorId: ownerId,
  });

  const publishedRevision = await getRevisionById(revision.id);
  if (!publishedRevision) throw new Error("测试 AgentRevision 发布后无法回读");
  return { agent, revision: publishedRevision, attestation };
}

// ─── seed Runtime + published RuntimeRevision ────────────────

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  capabilities: string[],
  contentSuffix: string,
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const artifactContent = `runtime-content-${contentSuffix}`;
  const artifactDigest = computeArtifactDigest(artifactContent);

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${artifactDigest}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "managed",
    networkZone: "internal",
    configHash: `sha256:config_${contentSuffix}`,
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    artifactContent,
  );
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  const publishedRevision = await getRuntimeRevisionById(revision.id);
  if (!publishedRevision) throw new Error("测试 RuntimeRevision 发布后无法回读");
  return { runtime, revision: publishedRevision, attestation };
}

// ─── seed 完整调度上下文 ─────────────────────────────────────

export interface DispatchableTurnContext {
  tenantId: string;
  ownerId: string;
  agentId: string;
  agentRevision: AgentRevision;
  runtimeRevision: RuntimeRevision;
  routeId: string;
  routeSetId: string;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

/**
 * 从空库建出可真正调度的 turn。调用方 beforeEach 需先 resetDatabase。
 *
 * @param overrides 可选的 agentKey / runtimeKey / contentSuffix，便于并发测试隔离。
 */
export async function seedDispatchableTurn(
  overrides: { agentKey?: string; runtimeKey?: string; contentSuffix?: string } = {},
): Promise<DispatchableTurnContext> {
  const suffix = overrides.contentSuffix ?? randomUUID().slice(0, 8);
  const agentKey = overrides.agentKey ?? `finance-${suffix}`;
  const runtimeKey = overrides.runtimeKey ?? `hosted-${suffix}`;

  const { tenantId, ownerId } = await seedTenantAndOwner();

  const { agent, revision: agentRevision } = await seedPublishedAgentRevision(
    tenantId,
    ownerId,
    agentKey,
    ["event_stream"],
    suffix,
  );
  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    runtimeKey,
    ["event_stream"],
    suffix,
  );

  const routeSet = await createRouteSet({
    tenantId,
    agentId: agent.id,
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  const routeResult = await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    agentRevisionId: agentRevision.id,
    runtimeRevisionId: runtimeRevision.id,
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    primaryAgentId: agent.id,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析数据" },
    actorId: ownerId,
  });

  return {
    tenantId,
    ownerId,
    agentId: agent.id,
    agentRevision,
    runtimeRevision,
    routeId: routeResult.route.id,
    routeSetId: routeSet.id,
    threadId: thread.id,
    turnId: turn.id,
    triggerItemId: turn.triggerItemId ?? null,
  };
}
