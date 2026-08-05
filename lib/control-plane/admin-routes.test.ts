/**
 * S03-C05：V11 Admin API route handlers 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖 4 个 Admin API 路由：
 * - POST /admin/api/v1/agents/{agent_id}/revisions — 创建 AgentRevision。
 * - POST /admin/api/v1/agent-revisions/{revision_id}:publish — 发布 AgentRevision（attestation 门禁）。
 * - POST /admin/api/v1/artifact-attestations:verify — 验证制品证明。
 * - PUT /admin/api/v1/deployment-routes/{route_id} — 更新 DeploymentRoute。
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolveV11Principal 使用 DEFAULT_USER_ID）。
 * 真实 ed25519 签名 + 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { type KeyObject, createHash, generateKeyPairSync, sign } from "node:crypto";
import { POST as publishPOST } from "@/app/admin/api/v1/agent-revisions/[revision_id]:publish/route";
import { POST as verifyPOST } from "@/app/admin/api/v1/artifact-attestations:verify/route";
import { POST as createRevisionPOST } from "@/app/admin/api/v1/agents/[agent_id]/revisions/route";
import { PUT as updateRoutePUT } from "@/app/admin/api/v1/deployment-routes/[route_id]/route";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  createDraftRevision,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { controlPlaneOutboxEvent } from "@/lib/control-plane/events/control-plane-outbox";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type SbomDocument,
  type SignatureBundle,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import {
  resetArtifactStoreOverrides,
  setArtifactStoreOverride,
  setBuilderKeyRegistryOverride,
} from "@/lib/artifacts/infrastructure/artifact-store-provider";
import { listAttestationsByRevision } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getPublicationRecordBySubject } from "@/lib/publications/persistence/publication-record-queries";
import {
  createRouteSet,
  getRouteSetById,
  upsertDeploymentRoute,
} from "@/lib/routes/application/deployment-route-service";
import { createRuntime } from "@/lib/runtimes/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtimes/persistence/runtime-revision-queries";
import { findIdempotencyRecord } from "@/lib/v11/identity/idempotency-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/v11/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/v11/test-support/publish-trusted-runtime-revision";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 identity.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  resetArtifactStoreOverrides();
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private signatures = new Map<string, SignatureBundle>();
  private sboms = new Map<string, SbomDocument>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeSignatureBundle(ref: string, bundle: SignatureBundle): void {
    this.signatures.set(ref, bundle);
  }
  writeSbom(ref: string, doc: SbomDocument): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readSignatureBundle(ref: string): Promise<SignatureBundle> {
    const bundle = this.signatures.get(ref);
    if (!bundle) throw new Error(`signature bundle not found: ${ref}`);
    return bundle;
  }
  async readSbom(ref: string): Promise<SbomDocument> {
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

// ─── 辅助：ed25519 密钥对 + 签名 ───────────────────────────

interface BuilderKeyPair {
  builderIdentity: string;
  publicKeyBase64: string;
  privateKey: KeyObject;
}

function generateBuilderKeyPair(builderIdentity: string): BuilderKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = Buffer.from(der.subarray(der.length - 32));
  return { builderIdentity, publicKeyBase64: rawPublicKey.toString("base64"), privateKey };
}

function signEd25519(privateKey: KeyObject, payload: string): string {
  const sig = sign(null, Buffer.from(payload, "utf-8"), privateKey);
  return sig.toString("base64");
}

function buildValidSignatureBundle(keyPair: BuilderKeyPair, digest: string): SignatureBundle {
  return {
    algorithm: "ed25519",
    publicKey: keyPair.publicKeyBase64,
    signature: signEd25519(keyPair.privateKey, digest),
  };
}

function buildCleanSbom(): SbomDocument {
  return {
    packages: [{ name: "lodash", version: "4.17.21", licenses: ["MIT"], vulnerabilities: [] }],
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

// ─── 辅助：seed admin 用户 + action bindings ────────────────

async function seedAdminWithActionBindings() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.revision.create",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "agent.publish",
    resourceScope: { type: "agent", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "artifact.attestation.verify",
    resourceScope: { type: "artifact_type", wildcard: true },
  });
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "route.update",
    resourceScope: { type: "agent", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

// ─── 辅助：直接创建 verified attestation（绕过 route handler）─

async function createVerifiedAttestationDirect(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
): Promise<string> {
  const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const sigRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;
  const store = new InMemoryManagedArtifactStore();
  store.writeSignatureBundle(sigRef, buildValidSignatureBundle(keyPair, digest));
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());
  const attestation = await verifyAndPersistAttestation(
    {
      tenantId,
      artifactType,
      artifactRevisionId,
      artifactDigest: digest,
      signatureBundleRef: sigRef,
      sbomRef,
      provenanceRef: provRef,
      builderIdentity: "builder:company-agent-runtime",
    },
    store,
    builderKeys,
    { tenantId, actorType: "service", actorId: "test-builder" },
    "test-request-id",
  );
  return attestation.id;
}

// ─── 辅助：seed Agent + published AgentRevision + attestation ─

async function seedPublishedAgentRevision(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  contentSuffix: string,
) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
  });

  const revision = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: `git:${contentSuffix}`,
    instructionHash: `sha256:instruction_${contentSuffix}`,
    agentArtifactRef: `oci://registry/agent@sha256:${contentSuffix}`,
    modelPolicyJson: { default: "doubao-pro" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: { allowed_agent_ids: [] },
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: [] },
    createdBy: ownerId,
  });

  await createVerifiedAttestationDirect(
    tenantId,
    "agent_revision",
    revision.id,
    `agent-content-${contentSuffix}`,
  );
  await publishRevision(tenantId, revision.id, 1);

  return { agent, revision };
}

// ─── 辅助：seed Runtime + published RuntimeRevision + attestation ─

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  contentSuffix: string,
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
  });

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@sha256:${contentSuffix}`,
    runtimeCapabilitiesJson: ["event_stream", "steer", "cancel", "tool_call"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: `sha256:${createHash("sha256").update(`config_${contentSuffix}`).digest("hex")}`,
    createdBy: ownerId,
  });

  const attestationId = await createVerifiedAttestationDirect(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId,
  });

  return { runtime, revision };
}

// ═══════════════════════════════════════════════════════════
// 1. POST /admin/api/v1/artifact-attestations:verify
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/artifact-attestations:verify", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
  });

  it("成功验证 → 200 + verification_state=verified", async () => {
    // 先创建一个 draft AgentRevision 作为 artifact_revision_id 目标
    const agent = await createAgent({
      tenantId,
      agentKey: "verify-agent",
      displayName: "Verify Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:verify-v1",
      instructionHash: "sha256:instr-verify",
      agentArtifactRef: "oci://registry/agent@sha256:verify",
      modelPolicyJson: { model: "gpt-4" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    // 准备 store override + builder keys override
    const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("verify-artifact-content");
    const sigRef = `attestation:signature:${digest.slice(7, 15)}`;
    const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
    const provRef = `attestation:provenance:${digest.slice(7, 15)}`;
    const store = new InMemoryManagedArtifactStore();
    store.writeSignatureBundle(sigRef, buildValidSignatureBundle(keyPair, digest));
    store.writeSbom(sbomRef, buildCleanSbom());
    store.writeProvenance(provRef, buildValidProvenance());
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations:verify",
      idempotencyKey: "idem-verify-001",
      body: {
        artifact_type: "agent_revision",
        artifact_revision_id: draftRevision.id,
        artifact_digest: digest,
        signature_bundle_ref: sigRef,
        sbom_ref: sbomRef,
        provenance_ref: provRef,
        builder_identity: "builder:company-agent-runtime",
      },
    });

    const response = await verifyPOST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.verification_state).toBe("verified");
    expect(body.attestation_id).toEqual(expect.any(String));
    expect(typeof body.attestation_id).toBe("string");
    // UUID 格式校验
    const attestationId = body.attestation_id as string;
    expect(attestationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const digest = computeArtifactDigest("no-idem-content");
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations:verify",
      body: {
        artifact_type: "agent_revision",
        artifact_revision_id: "rev-1",
        artifact_digest: digest,
        signature_bundle_ref: "attestation:signature:x",
        sbom_ref: "attestation:sbom:x",
        provenance_ref: "attestation:provenance:x",
        builder_identity: "builder:company-agent-runtime",
      },
    });

    const response = await verifyPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("验证失败 → 422 ARTIFACT_ATTESTATION_FAILED", async () => {
    // 用错误的密钥签名 → 验签失败
    const goodKeyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    const badKeyPair = generateBuilderKeyPair("builder:attacker");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": goodKeyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("bad-sig-content");
    const sigRef = "attestation:signature:bad";
    const sbomRef = "attestation:sbom:bad";
    const provRef = "attestation:provenance:bad";
    const store = new InMemoryManagedArtifactStore();
    // 用 badKeyPair 签名（公钥与白名单不一致）
    store.writeSignatureBundle(sigRef, buildValidSignatureBundle(badKeyPair, digest));
    store.writeSbom(sbomRef, buildCleanSbom());
    store.writeProvenance(provRef, buildValidProvenance());
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const requestBody = {
      artifact_type: "agent_revision",
      artifact_revision_id: "rev-bad-sig",
      artifact_digest: digest,
      signature_bundle_ref: sigRef,
      sbom_ref: sbomRef,
      provenance_ref: provRef,
      builder_identity: "builder:company-agent-runtime",
    };
    const buildRequest = () =>
      buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/artifact-attestations:verify",
        idempotencyKey: "idem-verify-fail",
        body: requestBody,
      });

    const response = await verifyPOST(buildRequest());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ARTIFACT_ATTESTATION_FAILED");

    const replay = await verifyPOST(buildRequest());
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual(body);
    expect(
      await listAttestationsByRevision(tenantId, "agent_revision", "rev-bad-sig"),
    ).toHaveLength(1);
    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: "artifact.attestation.verify:rev-bad-sig",
      idempotencyKey: "idem-verify-fail",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.httpStatus).toBe(422);
  });

  it("幂等重放 → 200 (same response)", async () => {
    const keyPair = generateBuilderKeyPair("builder:company-agent-runtime");
    const builderKeys: BuilderKeyRegistry = {
      "builder:company-agent-runtime": keyPair.publicKeyBase64,
    };
    const digest = computeArtifactDigest("replay-content");
    const sigRef = "attestation:signature:replay";
    const sbomRef = "attestation:sbom:replay";
    const provRef = "attestation:provenance:replay";
    const store = new InMemoryManagedArtifactStore();
    store.writeSignatureBundle(sigRef, buildValidSignatureBundle(keyPair, digest));
    store.writeSbom(sbomRef, buildCleanSbom());
    store.writeProvenance(provRef, buildValidProvenance());
    setArtifactStoreOverride(store);
    setBuilderKeyRegistryOverride(builderKeys);

    const body = {
      artifact_type: "agent_revision",
      artifact_revision_id: "rev-replay",
      artifact_digest: digest,
      signature_bundle_ref: sigRef,
      sbom_ref: sbomRef,
      provenance_ref: provRef,
      builder_identity: "builder:company-agent-runtime",
    };

    const request1 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations:verify",
      idempotencyKey: "idem-replay-001",
      body,
    });
    const response1 = await verifyPOST(request1);
    expect(response1.status).toBe(200);
    const body1 = (await response1.json()) as Record<string, unknown>;

    const request2 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/artifact-attestations:verify",
      idempotencyKey: "idem-replay-001",
      body,
    });
    const response2 = await verifyPOST(request2);
    expect(response2.status).toBe(200);
    const body2 = (await response2.json()) as Record<string, unknown>;

    expect(body2.attestation_id).toBe(body1.attestation_id);
    expect(body2.verification_state).toBe(body1.verification_state);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. POST /admin/api/v1/agents/{agent_id}/revisions
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/agents/{agent_id}/revisions", () => {
  let tenantId: string;
  let userIdentityId: string;
  let agentId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const agent = await createAgent({
      tenantId,
      agentKey: "rev-agent",
      displayName: "Revision Agent",
      ownerUserId: userIdentityId,
    });
    agentId = agent.id;
  });

  it("成功创建 → 201 + ETag", async () => {
    const artifactDigest = computeArtifactDigest("test-artifact-content");
    const instructionHash = computeArtifactDigest("test-instruction-content");
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agents/test-agent-id/revisions",
      idempotencyKey: "idem-create-rev-001",
      body: {
        source: { source_type: "import", ref: "test-ref" },
        artifact_digest: artifactDigest,
        instruction_hash: instructionHash,
        model_policy: { model: "gpt-4" },
        permission_requirements: [],
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: agentId }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toEqual(expect.any(String));
    expect(body.revision_no).toBe(1);
    expect(body.revision_state).toBe("draft");
    const etag = response.headers.get("etag");
    expect(etag).toBeDefined();
    expect(etag).toContain("agent-revision-1");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agents/test-agent-id/revisions",
      body: {
        source: { source_type: "import", ref: "test-ref" },
        artifact_digest: computeArtifactDigest("no-idem"),
        instruction_hash: computeArtifactDigest("no-idem-instr"),
        model_policy: { model: "gpt-4" },
        permission_requirements: [],
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: agentId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("跨租户 Agent → 404 RESOURCE_NOT_FOUND", async () => {
    const crossTenantRequestId = "req-cross-tenant-rev";
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agents/random-uuid/revisions",
      requestId: crossTenantRequestId,
      idempotencyKey: "idem-cross-tenant-001",
      body: {
        source: { source_type: "import", ref: "test-ref" },
        artifact_digest: computeArtifactDigest("cross-tenant"),
        instruction_hash: computeArtifactDigest("cross-tenant-instr"),
        model_policy: { model: "gpt-4" },
        permission_requirements: [],
        delegation_policy: { max_depth: 0 },
        agent_interface_requirements: { required: [], optional: [] },
      },
    });

    const randomAgentId = "99999999-9999-4999-8999-999999999999";
    const response = await createRevisionPOST(request, {
      params: Promise.resolve({ agent_id: randomAgentId }),
    });
    await assertCrossTenantHidden(response, crossTenantRequestId);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. POST /admin/api/v1/agent-revisions/{revision_id}:publish
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/agent-revisions/{revision_id}:publish", () => {
  let tenantId: string;
  let userIdentityId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
  });

  it("成功发布 → 200", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "publish-agent",
      displayName: "Publish Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:publish-v1",
      instructionHash: "sha256:instr-publish",
      agentArtifactRef: "oci://registry/agent@sha256:publish",
      modelPolicyJson: { model: "gpt-4" },
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });
    const attestationId = await createVerifiedAttestationDirect(
      tenantId,
      "agent_revision",
      draftRevision.id,
      "publish-artifact-content",
    );

    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev:publish",
      idempotencyKey: "idem-publish-001",
      ifMatch: "agent-revision-1",
      body: {
        release_notes: "Initial release",
        artifact_attestation_id: attestationId,
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.revision_state).toBe("published");
    expect(body.published_at).toBeTruthy();

    const publishedAgent = await getAgentById(tenantId, agent.id);
    expect(publishedAgent?.currentRevisionId).toBe(draftRevision.id);

    const outbox = await db
      .select()
      .from(controlPlaneOutboxEvent)
      .where(eq(controlPlaneOutboxEvent.aggregateId, draftRevision.id));
    expect(outbox).toHaveLength(1);

    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: `agent.publish:${draftRevision.id}`,
      idempotencyKey: "idem-publish-001",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRedactedJson).toBe(JSON.stringify(body));
    expect(
      await getPublicationRecordBySubject({
        tenantId,
        subjectType: "agent_revision",
        subjectRevisionId: draftRevision.id,
      }),
    ).toMatchObject({
      attestationIds: [attestationId],
      idempotencyKey: "idem-publish-001",
      idempotencyRecordId: idempotency?.id,
      publishedByType: "user",
      publishedBy: userIdentityId,
    });

    const replayRequest = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev:publish",
      idempotencyKey: "idem-publish-001",
      ifMatch: "agent-revision-1",
      body: {
        release_notes: "Initial release",
        artifact_attestation_id: attestationId,
      },
    });
    const replayResponse = await publishPOST(replayRequest, {
      params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(body);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, draftRevision.id)),
    ).toHaveLength(1);
  });

  it("两个不同幂等键并发发布时只返回一个成功结果", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "concurrent-publish-agent",
      displayName: "Concurrent Publish Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:concurrent-publish-v1",
      instructionHash: "sha256:instr-concurrent-publish",
      agentArtifactRef: "oci://registry/agent@sha256:concurrent-publish",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });
    const attestationId = await createVerifiedAttestationDirect(
      tenantId,
      "agent_revision",
      draftRevision.id,
      "concurrent-publish-content",
    );
    const buildRequest = (idempotencyKey: string) =>
      buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/agent-revisions/rev:publish",
        idempotencyKey,
        ifMatch: "agent-revision-1",
        body: {
          release_notes: "Concurrent release",
          artifact_attestation_id: attestationId,
        },
      });

    const responses = await Promise.all([
      publishPOST(buildRequest("idem-concurrent-publish-1"), {
        params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
      }),
      publishPOST(buildRequest("idem-concurrent-publish-2"), {
        params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await getRevisionById(draftRevision.id))?.revisionState).toBe("published");
    expect((await getAgentById(tenantId, agent.id))?.currentRevisionId).toBe(draftRevision.id);
    expect(
      await db
        .select()
        .from(controlPlaneOutboxEvent)
        .where(eq(controlPlaneOutboxEvent.aggregateId, draftRevision.id)),
    ).toHaveLength(1);
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "no-ifmatch-agent",
      displayName: "No IfMatch Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:no-ifmatch",
      instructionHash: "sha256:instr-no-ifmatch",
      agentArtifactRef: "oci://registry/agent@sha256:no-ifmatch",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev:publish",
      idempotencyKey: "idem-no-ifmatch-001",
      body: {
        release_notes: "Initial release",
        artifact_attestation_id: "fake-attestation-id",
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "etag-mismatch-agent",
      displayName: "ETag Mismatch Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:etag-mismatch",
      instructionHash: "sha256:instr-etag-mismatch",
      agentArtifactRef: "oci://registry/agent@sha256:etag-mismatch",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });
    const attestationId = await createVerifiedAttestationDirect(
      tenantId,
      "agent_revision",
      draftRevision.id,
      "etag-mismatch-content",
    );

    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev:publish",
      idempotencyKey: "idem-etag-mismatch-001",
      ifMatch: "agent-revision-999",
      body: {
        release_notes: "Initial release",
        artifact_attestation_id: attestationId,
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("attestation 未验证 → 409 ARTIFACT_NOT_VERIFIED", async () => {
    const agent = await createAgent({
      tenantId,
      agentKey: "no-attest-agent",
      displayName: "No Attestation Agent",
      ownerUserId: userIdentityId,
    });
    const draftRevision = await createDraftRevision({
      tenantId,
      agentId: agent.id,
      sourceType: "agent_yaml",
      sourceRevision: "git:no-attest",
      instructionHash: "sha256:instr-no-attest",
      agentArtifactRef: "oci://registry/agent@sha256:no-attest",
      modelPolicyJson: {},
      permissionRequirementsJson: {},
      delegationPolicyJson: {},
      agentInterfaceRequirementsJson: { required: [], optional: [] },
      createdBy: userIdentityId,
    });

    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/agent-revisions/rev:publish",
      idempotencyKey: "idem-no-attest-001",
      ifMatch: "agent-revision-1",
      body: {
        release_notes: "Initial release",
        artifact_attestation_id: "99999999-9999-4999-8999-999999999999",
      },
    });

    const response = await publishPOST(request, {
      params: Promise.resolve({ "revision_id:publish": draftRevision.id }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ARTIFACT_NOT_VERIFIED");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. PUT /admin/api/v1/deployment-routes/{route_id}
// ═══════════════════════════════════════════════════════════

describe("PUT /admin/api/v1/deployment-routes/{route_id}", () => {
  let tenantId: string;
  let userIdentityId: string;
  let agentId: string;
  let agentRevisionId: string;
  let runtimeRevisionId: string;
  let routeSetId: string;
  let routeId: string;
  let currentVersionNo: number;

  beforeEach(async () => {
    const seeded = await seedAdminWithActionBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;

    const agentResult = await seedPublishedAgentRevision(
      tenantId,
      userIdentityId,
      "route-put-agent",
      "agent-v1",
    );
    agentId = agentResult.agent.id;
    agentRevisionId = agentResult.revision.id;

    const runtimeResult = await seedPublishedRuntimeRevision(
      tenantId,
      userIdentityId,
      "route-put-runtime",
      "runtime-v1",
    );
    runtimeRevisionId = runtimeResult.revision.id;

    const routeSet = await createRouteSet({
      tenantId,
      agentId,
      routeScopeKey: "prod",
      routeScopeJson: { networkZone: "internal" },
    });
    routeSetId = routeSet.id;

    const upsertResult = await upsertDeploymentRoute({
      tenantId,
      routeSetId,
      routeSetExpectedVersionNo: 1,
      agentRevisionId,
      runtimeRevisionId,
      trafficWeight: 5000,
      priorityNo: 1,
      actor: { tenantId, actorType: "service", actorId: "test-deploy-bot" },
    });
    routeId = upsertResult.route.id;
    currentVersionNo = upsertResult.routeSet.versionNo;
  });

  it("成功更新 → 200 + 新 ETag", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PUT",
      path: `/deployment-routes/${routeId}`,
      idempotencyKey: "idem-put-route-001",
      ifMatch: `route-set-${currentVersionNo}`,
      body: {
        route_set_id: routeSetId,
        agent_revision_id: agentRevisionId,
        runtime_revision_id: runtimeRevisionId,
        traffic_weight: 10000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    const response = await updateRoutePUT(request, {
      params: Promise.resolve({ route_id: routeId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.etag).toBe(`route-set-${currentVersionNo + 1}`);
    expect(body.route_set_version_no).toBe(currentVersionNo + 1);
    expect(body.traffic_weight).toBe(10000);
    const etag = response.headers.get("etag");
    expect(etag).toBeDefined();
    expect(etag).toContain(`route-set-${currentVersionNo + 1}`);
  });

  it("提交后使用相同 Idempotency-Key 重试返回原结果，不创建重复激活", async () => {
    const requestBody = {
      route_set_id: routeSetId,
      agent_revision_id: agentRevisionId,
      runtime_revision_id: runtimeRevisionId,
      traffic_weight: 9000,
      priority_no: 1,
      route_state: "enabled",
    };
    const buildRequest = () =>
      buildV11Request({
        audience: "admin",
        method: "PUT",
        path: `/deployment-routes/${routeId}`,
        idempotencyKey: "idem-put-route-retry-001",
        ifMatch: `route-set-${currentVersionNo}`,
        body: requestBody,
      });

    const first = await updateRoutePUT(buildRequest(), {
      params: Promise.resolve({ route_id: routeId }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.route_revision_id).toBeTruthy();
    expect(firstBody.route_activation_id).toBeTruthy();

    const replay = await updateRoutePUT(buildRequest(), {
      params: Promise.resolve({ route_id: routeId }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const idempotency = await findIdempotencyRecord({
      tenantId,
      audience: "admin",
      callerType: "user",
      callerId: userIdentityId,
      commandScope: `route.update:${routeId}`,
      idempotencyKey: "idem-put-route-retry-001",
    });
    expect(idempotency?.processingState).toBe("completed");
    expect(idempotency?.responseRedactedJson).toBe(JSON.stringify(firstBody));
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PUT",
      path: `/deployment-routes/${routeId}`,
      idempotencyKey: "idem-put-no-ifmatch-001",
      body: {
        route_set_id: routeSetId,
        agent_revision_id: agentRevisionId,
        runtime_revision_id: runtimeRevisionId,
        traffic_weight: 8000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    const response = await updateRoutePUT(request, {
      params: Promise.resolve({ route_id: routeId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "PUT",
      path: `/deployment-routes/${routeId}`,
      idempotencyKey: "idem-put-etag-mismatch-001",
      ifMatch: "route-set-999",
      body: {
        route_set_id: routeSetId,
        agent_revision_id: agentRevisionId,
        runtime_revision_id: runtimeRevisionId,
        traffic_weight: 8000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    const response = await updateRoutePUT(request, {
      params: Promise.resolve({ route_id: routeId }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("跨租户 Route → 404 RESOURCE_NOT_FOUND", async () => {
    const crossTenantRequestId = "req-cross-tenant-route";
    const request = buildV11Request({
      audience: "admin",
      method: "PUT",
      path: "/deployment-routes/random-uuid",
      requestId: crossTenantRequestId,
      idempotencyKey: "idem-put-cross-tenant-001",
      ifMatch: `route-set-${currentVersionNo}`,
      body: {
        route_set_id: routeSetId,
        agent_revision_id: agentRevisionId,
        runtime_revision_id: runtimeRevisionId,
        traffic_weight: 8000,
        priority_no: 1,
        route_state: "enabled",
      },
    });

    const randomRouteId = "99999999-9999-4999-8999-999999999999";
    const response = await updateRoutePUT(request, {
      params: Promise.resolve({ route_id: randomRouteId }),
    });
    await assertCrossTenantHidden(response, crossTenantRequestId);
  });
});
