/**
 * EffectiveInvocationCapabilities 测试（05 §2/§3/§4/§7/§8）。
 *
 * 不变量：
 * - Agent Route：contract.cancel AND runtime.measured.cancel==pass AND 协议实现支持；
 * - Base Harness（无 Snapshot）：runtime measured AND 协议实现（Hosted 现有语义保持）；
 * - 事实不可解析（Revision/Snapshot 缺失或跨租户）→ fail-closed 全 false；
 * - 输入只来自 Binding 冻结证据，不查最新 Agent/Runtime。
 */
import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { hrAgentContract } from "@/lib/agents/test-support/hr-agent-contract";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { computeArtifactDigest } from "@/lib/artifacts/domain/artifact-attestation";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  resolveEffectiveInvocationCapabilities,
  resolveRuntimeLevelCapabilities,
} from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createVerifiedAttestation } from "@/lib/test-support/create-verified-attestation";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { beforeEach, describe, expect, it } from "vitest";

/** External 三态投影（02 §10 形状）。 */
function projection(flags: {
  cancel?: string;
  resume?: string;
  inputRequired?: string;
  streaming?: string;
}) {
  return {
    declared: {},
    measured: {
      features: {
        streaming_transport: flags.streaming ?? "pass",
        incremental_content: "not_applicable",
        input_required: flags.inputRequired ?? "pass",
        resume: flags.resume ?? "pass",
        cancel: flags.cancel ?? "pass",
        durable_task_recovery: "not_measured",
      },
    },
    effective: {},
  };
}

/** Hosted string[] 契约。 */
const HOSTED_CAPS = ["event_stream"];

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedTenant() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "caps-owner",
    email: "caps-owner@example.com",
    displayName: "Caps Owner",
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

async function seedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeCapabilitiesJson: unknown,
): Promise<string> {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey: `caps-runtime-${randomUUID()}`,
    displayName: "Caps Runtime",
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });
  const content = `caps-content-${randomUUID()}`;
  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: "https://caps-runtime.internal",
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest(content)}`,
    runtimeCapabilitiesJson,
    identityMode: "none",
    networkZone: "internal",
    configHash: computeArtifactDigest(`caps-config-${content}`),
    createdBy: ownerId,
  });
  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    content,
  );
  await publishRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });
  return revision.id;
}

async function seedSnapshot(
  tenantId: string,
  ownerId: string,
  flags: { cancel: boolean; resume: boolean },
): Promise<{ id: string; contextDigest: string }> {
  const agent = await createAgent({
    tenantId,
    agentKey: `caps-agent-${randomUUID()}`,
    displayName: "Caps Agent",
    ownerUserId: ownerId,
  });
  const snapshot = await seedAgentContractSnapshot({
    tenantId,
    agentId: agent.id,
    createdBy: "test-operator",
    contract: {
      ...hrAgentContract,
      interaction: {
        ...hrAgentContract.interaction,
        cancel: flags.cancel,
        resume: flags.resume,
      },
    },
  });
  return { id: snapshot.id, contextDigest: snapshot.contextDigest };
}

describe("resolveRuntimeLevelCapabilities（05 §4 Base Harness）", () => {
  it("Hosted（string[] 契约）：cancel/resume 可用（Hosted 现有语义保持）", () => {
    const caps = resolveRuntimeLevelCapabilities({
      protocolType: "harness_runtime_protocol",
      runtimeCapabilitiesJson: HOSTED_CAPS,
    });
    expect(caps.cancel).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.streaming).toBe(true);
  });

  it("External 三态投影：只认 measured.features===pass", () => {
    const caps = resolveRuntimeLevelCapabilities({
      protocolType: "harness_runtime_protocol",
      runtimeCapabilitiesJson: projection({ cancel: "pass", resume: "not_applicable" }),
    });
    expect(caps.cancel).toBe(true);
    expect(caps.resume).toBe(false);
    // External 投影不含 steer（measured.steer 恒 false）。
    expect(caps.steer).toBe(false);
  });

  it("形状不可识别/未知协议 → fail-closed 全 false", () => {
    expect(
      resolveRuntimeLevelCapabilities({
        protocolType: "harness_runtime_protocol",
        runtimeCapabilitiesJson: { unknown: true },
      }).cancel,
    ).toBe(false);
    expect(
      resolveRuntimeLevelCapabilities({
        protocolType: "mystery",
        runtimeCapabilitiesJson: HOSTED_CAPS,
      }).cancel,
    ).toBe(false);
  });
});

describe("resolveEffectiveInvocationCapabilities（05 §3 精确公式）", () => {
  it("Agent Route：contract.cancel AND measured pass AND 协议实现 → true", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(
      tenantId,
      ownerId,
      projection({ cancel: "pass", resume: "pass" }),
    );
    const snapshot = await seedSnapshot(tenantId, ownerId, { cancel: true, resume: true });
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { agentContractSnapshotId: snapshot.id, runtimeRevisionId },
    });
    expect(caps.cancel).toBe(true);
    expect(caps.resume).toBe(true);
  });

  it("合同 cancel=false → false（即使 measured pass + 协议支持）", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(tenantId, ownerId, projection({}));
    const snapshot = await seedSnapshot(tenantId, ownerId, { cancel: false, resume: true });
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { agentContractSnapshotId: snapshot.id, runtimeRevisionId },
    });
    expect(caps.cancel).toBe(false);
    expect(caps.resume).toBe(true);
  });

  it("measured cancel=not_applicable → false（即使合同声明 true）", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(
      tenantId,
      ownerId,
      projection({ cancel: "not_applicable" }),
    );
    const snapshot = await seedSnapshot(tenantId, ownerId, { cancel: true, resume: true });
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { agentContractSnapshotId: snapshot.id, runtimeRevisionId },
    });
    expect(caps.cancel).toBe(false);
  });

  it("Base Harness（snapshot null）：runtime measured AND 协议实现", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(tenantId, ownerId, projection({}));
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { agentContractSnapshotId: null, runtimeRevisionId },
    });
    expect(caps.cancel).toBe(true);
  });

  it("RuntimeRevision 不存在 → fail-closed 全 false", async () => {
    const { tenantId } = await seedTenant();
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { agentContractSnapshotId: null, runtimeRevisionId: "revision-not-exist" },
    });
    expect(caps.cancel).toBe(false);
  });

  it("Snapshot 跨租户/缺失 → fail-closed 全 false", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(tenantId, ownerId, projection({}));
    const other = await resolveEffectiveInvocationCapabilities({
      tenantId: "other-tenant",
      binding: { agentContractSnapshotId: "snapshot-not-exist", runtimeRevisionId },
    });
    expect(other.cancel).toBe(false);
    expect(other.resume).toBe(false);
  });
});
