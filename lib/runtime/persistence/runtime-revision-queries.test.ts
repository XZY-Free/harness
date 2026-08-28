/**
 * RuntimeRevision 证据完整性 fail-closed 测试（03 §3/§5）。
 *
 * 覆盖 Batch 3 Gate：
 * - Hosted 证据不降级：runtimeArtifactRef 与 artifact digest 缺一不可；
 * - External Runtime 不伪造 Artifact：external_endpoint 拒绝 runtimeArtifactRef；
 * - protocol 合同明确：protocolContractRevision 必须显式传入，禁止空串/默认值推导。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import {
  RuntimeRevisionEvidenceError,
  createDraftRuntimeRevision,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

async function seedTenantAndRuntime(runtimeKind: "hosted" | "external") {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "revision-queries-owner",
    email: "revision-queries-owner@example.com",
    displayName: "Revision Queries Owner",
  });
  const runtime = await createRuntime({
    tenantId: tenant.id,
    runtimeKey: `runtime-evidence-${runtimeKind}`,
    displayName: `Runtime ${runtimeKind}`,
    runtimeKind,
    ownerUserId: owner.id,
  });
  return { tenant, owner, runtime };
}

const HOSTED_REF = `oci://registry/runtime@sha256:${"a".repeat(64)}`;

describe("RuntimeRevision 证据完整性 fail-closed（03 §3/§4/§5）", () => {
  it("hosted_artifact 缺 runtimeArtifactRef → 拒绝（Hosted 证据不降级）", async () => {
    const { tenant, owner, runtime } = await seedTenantAndRuntime("hosted");
    await expect(
      createDraftRuntimeRevision({
        tenantId: tenant.id,
        runtimeId: runtime.id,
        protocolType: "harness_runtime_protocol",
        protocolContractRevision: "harness-runtime-protocol@1",
        runtimeEvidenceKind: "hosted_artifact",
        endpointRef: "managed://runtime/evidence",
        runtimeArtifactRef: null,
        runtimeCapabilitiesJson: {},
        identityMode: "workload_token",
        networkZone: "internal",
        configHash: `sha256:${"b".repeat(64)}`,
        createdBy: owner.id,
      }),
    ).rejects.toThrow(RuntimeRevisionEvidenceError);
  });

  it("external_endpoint 携带 runtimeArtifactRef → 拒绝（不伪造 Runtime Artifact）", async () => {
    const { tenant, owner, runtime } = await seedTenantAndRuntime("external");
    await expect(
      createDraftRuntimeRevision({
        tenantId: tenant.id,
        runtimeId: runtime.id,
        protocolType: "harness_runtime_protocol",
        protocolContractRevision: "harness-runtime-protocol@1",
        runtimeEvidenceKind: "external_endpoint",
        endpointRef: "https://external.example.com/a2a",
        runtimeArtifactRef: HOSTED_REF,
        runtimeCapabilitiesJson: {},
        identityMode: "api_key",
        networkZone: "external",
        configHash: `sha256:${"b".repeat(64)}`,
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/不得伪造 Runtime Artifact/);
  });

  it("protocolContractRevision 空串 → 拒绝（协议合同必须显式，禁止默认值推导）", async () => {
    const { tenant, owner, runtime } = await seedTenantAndRuntime("external");
    await expect(
      createDraftRuntimeRevision({
        tenantId: tenant.id,
        runtimeId: runtime.id,
        protocolType: "harness_runtime_protocol",
        protocolContractRevision: "  ",
        runtimeEvidenceKind: "external_endpoint",
        endpointRef: "https://external.example.com/a2a",
        runtimeArtifactRef: null,
        runtimeCapabilitiesJson: {},
        identityMode: "api_key",
        networkZone: "external",
        configHash: `sha256:${"b".repeat(64)}`,
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/protocolContractRevision 必须显式传入/);
  });

  it("external_endpoint 无 artifactRef 可建 draft，且 runtimeTargetDigest 非 hosted 事实", async () => {
    const { tenant, owner, runtime } = await seedTenantAndRuntime("external");
    const revision = await createDraftRuntimeRevision({
      tenantId: tenant.id,
      runtimeId: runtime.id,
      protocolType: "harness_runtime_protocol",
      protocolContractRevision: "harness-runtime-protocol@1",
      runtimeEvidenceKind: "external_endpoint",
      endpointRef: "https://external.example.com/a2a",
      runtimeArtifactRef: null,
      runtimeCapabilitiesJson: {},
      identityMode: "api_key",
      networkZone: "external",
      configHash: `sha256:${"b".repeat(64)}`,
      createdBy: owner.id,
    });
    expect(revision.runtimeEvidenceKind).toBe("external_endpoint");
    expect(revision.runtimeArtifactRef).toBeNull();
    expect(revision.artifactDigest).toBeNull();
    expect(revision.runtimeTargetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
