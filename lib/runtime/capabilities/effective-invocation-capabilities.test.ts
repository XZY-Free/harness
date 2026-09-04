/**
 * EffectiveInvocationCapabilities 测试（05 §2/§3/§4/§7/§8）。
 *
 * 专题01 冻结架构：ExecutionBinding 只绑定 Harness Runtime，effective capability
 * 退化为 runtime-only。不变量：
 * - runtime measured AND 协议实现（Hosted 现有语义保持）；
 * - 事实不可解析（RuntimeRevision 缺失）→ fail-closed 全 false；
 * - 输入只来自 Binding 冻结证据（runtimeRevisionId），不查最新 Agent/Runtime。
 */
import { randomUUID } from "node:crypto";
import { computeArtifactDigest } from "@/lib/artifacts/domain/artifact-attestation";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  resolveEffectiveInvocationCapabilities,
  resolveRuntimeLevelCapabilities,
  runtimeCapabilitiesMatchPublishedRevision,
} from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import { createVerifiedAttestation } from "@/lib/test-support/create-verified-attestation";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { beforeEach, describe, expect, it } from "vitest";

/** External 三态投影（02 §10 形状）。 */
function projection(flags: {
  cancel?: string;
  resume?: string;
  steer?: string;
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
        steer: flags.steer ?? "pass",
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
    expect(caps.steer).toBe(true);
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

describe("resolveEffectiveInvocationCapabilities（05 §3 精确公式；专题01 冻结架构 runtime-only）", () => {
  it("Hosted（string[] 契约）：cancel/resume → true", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(
      tenantId,
      ownerId,
      projection({ cancel: "pass", resume: "pass" }),
    );
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { runtimeRevisionId },
    });
    expect(caps.cancel).toBe(true);
    expect(caps.resume).toBe(true);
  });

  it("measured cancel=not_applicable → false", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(
      tenantId,
      ownerId,
      projection({ cancel: "not_applicable" }),
    );
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { runtimeRevisionId },
    });
    expect(caps.cancel).toBe(false);
  });

  it("runtime measured AND 协议实现（Base Harness 公式）", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(tenantId, ownerId, projection({}));
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { runtimeRevisionId },
    });
    expect(caps.cancel).toBe(true);
  });

  it("RuntimeRevision 不存在 → fail-closed 全 false", async () => {
    const { tenantId } = await seedTenant();
    const caps = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { runtimeRevisionId: "revision-not-exist" },
    });
    expect(caps.cancel).toBe(false);
  });

  it("Session 实际能力与 Revision measured 取交集，非法快照 fail-closed", async () => {
    const { tenantId, ownerId } = await seedTenant();
    const runtimeRevisionId = await seedRuntimeRevision(tenantId, ownerId, projection({}));
    const observed = defaultRuntimeCapabilities();
    observed.features.resume = false;
    const capabilities = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { runtimeRevisionId },
      sessionCapabilitiesJson: observed,
    });
    expect(capabilities.cancel).toBe(true);
    expect(capabilities.resume).toBe(false);

    const invalid = await resolveEffectiveInvocationCapabilities({
      tenantId,
      binding: { runtimeRevisionId },
      sessionCapabilitiesJson: { features: { resume: true } },
    });
    expect(invalid).toEqual({
      cancel: false,
      resume: false,
      steer: false,
      user_action: false,
      streaming: false,
    });
  });

  it("start response 的核心能力必须与已发布 measured 事实一致", () => {
    const observed = defaultRuntimeCapabilities();
    expect(
      runtimeCapabilitiesMatchPublishedRevision(
        {
          protocolType: "harness_runtime_protocol",
          runtimeCapabilitiesJson: projection({}),
        },
        observed,
      ),
    ).toBe(true);
    observed.features.cancel = false;
    expect(
      runtimeCapabilitiesMatchPublishedRevision(
        {
          protocolType: "harness_runtime_protocol",
          runtimeCapabilitiesJson: projection({}),
        },
        observed,
      ),
    ).toBe(false);
    expect(
      runtimeCapabilitiesMatchPublishedRevision(
        { protocolType: "harness_runtime_protocol", runtimeCapabilitiesJson: { unknown: true } },
        observed,
      ),
    ).toBe(false);
  });
});
