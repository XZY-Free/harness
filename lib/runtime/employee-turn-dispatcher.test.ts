import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn, getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { executionBindingTable } from "@/lib/persistence/schema/executions";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { dispatchEmployeeTurn } from "@/lib/runtime/employee-turn-dispatcher";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { subscribeThreadTransientEvents } from "@/lib/runtime/transient-event-bus";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

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
    const sbom = this.sboms.get(ref);
    if (!sbom) throw new Error(`SBOM not found: ${ref}`);
    return sbom;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const prov = this.provenances.get(ref);
    if (!prov) throw new Error(`Provenance not found: ${ref}`);
    return prov;
  }
}

// ─── 辅助：DSSE Envelope 构造（来自 test-support） ─────────
// generateTestBuilderKey / buildDsseArtifactAttestationEnvelope 来自 test-support。

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
    buildPipeline: "ci-cd-pipeline-1",
    sourceRevision: "git_commit_1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

// ─── 辅助：创建 verified attestation ───────────────────────

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

// ─── 辅助：seed Runtime + published RuntimeRevision + attestation ─

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  contentSuffix: string,
): Promise<{ runtime: { id: string }; revision: RuntimeRevision }> {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest(`runtime-content-${contentSuffix}`)}`,
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: computeArtifactDigest(`runtime-config-${contentSuffix}`),
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  return { runtime, revision };
}

describe("dispatchEmployeeTurn", () => {
  it("接纳的 Turn 会经内置 Hosted Runtime 生成并持久化真实 Agent 回复", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "employee-turn-owner",
      email: "employee-turn-owner@example.com",
      displayName: "Employee Turn Owner",
    });
    const tenantId = tenant.id;
    const ownerId = owner.id;

    // seed 完整 ready route：Runtime + published Revision、
    // RouteSet + active base harness Route（顶层恒为 runtime target={kind:"runtime"}，不携带 Agent 字段）。
    const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
      tenantId,
      ownerId,
      "default-runtime",
      "v1",
    );

    const routeSet = await createRouteSet({
      tenantId,
      target: { kind: "runtime" },
      routeScopeKey: "default",
      routeScopeJson: { networkZone: "internal" },
    });
    await activateSingleRouteForTest({
      tenantId,
      routeSetId: routeSet.id,
      routeSetExpectedVersionNo: 1,
      target: { kind: "runtime", runtimeRevisionId: runtimeRevision.id },
      trafficWeight: MAX_TRAFFIC_WEIGHT,
      priorityNo: 1,
      actor: buildActor(tenantId, "deploy-bot-001"),
    });

    const { thread } = await createThread({
      tenantId,
      ownerUserId: ownerId,
      actorId: ownerId,
    });
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: ownerId,
      content: { text: "请确认已经接通" },
      actorId: ownerId,
    });
    const deltas: string[] = [];
    const unsubscribe = subscribeThreadTransientEvents(thread.id, (event) => {
      if (event.type === "response.delta") deltas.push(event.payload.delta as string);
    });

    const dispatched = await dispatchEmployeeTurn({
      tenantId,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
      modelRef: "test-model",
      // 顶层恒为 base harness route；modelRef 作为 Thread 模型事实进入 Binding。
      decisionPort: {
        async decideNextAction() {
          return {
            actionId: "respond-1",
            stepNo: 1,
            actionType: "respond",
            purposeCode: "answer_ready",
            shortPurpose: "直接回答",
            payload: { evidenceRefs: [] },
          };
        },
      },
      finalResponsePort: {
        async generateFinalResponse(view, emitDelta) {
          await emitDelta?.("真实执行器");
          await emitDelta?.(`回复：${view.objective}`);
          return `真实执行器回复：${view.objective}`;
        },
      },
    });
    await dispatched.completion;
    unsubscribe();

    const updatedTurn = await getTurnById(tenantId, turn.id);
    const items = await listItemsByThread(tenantId, thread.id);
    const [binding] = await db
      .select({ modelId: executionBindingTable.modelId })
      .from(executionBindingTable)
      .where(eq(executionBindingTable.invocationId, updatedTurn?.latestInvocationId ?? ""))
      .limit(1);
    expect(dispatched.dispatched).toBe(true);
    expect(deltas).toEqual(["真实执行器", "回复：请确认已经接通"]);
    expect(updatedTurn?.turnState).toBe("completed");
    expect(binding?.modelId).toBe("test-model");
    expect(items.find((item) => item.itemType === "assistant_message")?.contentJson).toMatchObject({
      text: "真实执行器回复：请确认已经接通",
      model_ref: "test-model",
    });
  });
});
