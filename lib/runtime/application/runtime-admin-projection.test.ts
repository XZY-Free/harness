import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeRuntimeRevisionEligibility,
  loadRuntimeRevisionAdminProjection,
  projectRuntime,
} from "./runtime-admin-projection";

describe("runtime admin projection", () => {
  it("投影真实 Runtime 生命周期与版本", () => {
    expect(
      projectRuntime({
        id: "runtime-1",
        tenantId: "tenant-1",
        runtimeKey: "hosted",
        displayName: "Hosted",
        runtimeKind: "hosted",
        ownerUserId: "user-1",
        lifecycleState: "enabled",
        currentRevisionId: "revision-1",
        versionNo: 3,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
        updatedAt: new Date("2026-08-11T00:01:00.000Z"),
        deletedAt: null,
      }),
    ).toMatchObject({
      tenant_id: "tenant-1",
      kind: "hosted",
      lifecycle_state: "enabled",
      version_no: 3,
    });
  });

  it("只有冻结 Publication 证据和 Conformance 全部有效时可执行", () => {
    const base = {
      runtimeLifecycleState: "enabled",
      revisionState: "published",
      runtimeEvidenceKind: "hosted_artifact" as const,
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      publicationAttestationIds: ["attestation-1"],
      verifiedActiveAttestationIds: ["attestation-1"],
      publicationConformanceRunId: "run-1",
      validConformanceRunId: "run-1",
      hasPublication: true,
      hasWithdrawal: false,
    };
    expect(computeRuntimeRevisionEligibility(base)).toEqual({
      executionEligible: true,
      ineligibilityReasons: [],
    });
    expect(
      computeRuntimeRevisionEligibility({ ...base, validConformanceRunId: "run-2" }),
    ).toMatchObject({ executionEligible: false });
  });
});

describe("loadRuntimeRevisionAdminProjection agent_contract_snapshot_id", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterEach(async () => {
    await resetDatabase(db);
  });

  async function seedRuntimeRevision(options: {
    agentContractSnapshotId: string | null;
  }): Promise<{ tenantId: string; revisionId: string }> {
    const tenant = await ensureDefaultTenant();
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: `projection-runtime-${randomUUID()}`,
      displayName: "Projection Runtime",
      ownerUserId: randomUUID(),
    });
    const runtimeId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(runtimeTable).values({
      id: runtimeId,
      tenantId: tenant.id,
      runtimeKey: `runtime-${revisionId}`,
      displayName: "Runtime",
      runtimeKind: "external",
      ownerUserId: randomUUID(),
      lifecycleState: "enabled",
      currentRevisionId: revisionId,
      versionNo: 1,
    });
    await db.insert(runtimeRevisionTable).values({
      id: revisionId,
      runtimeId,
      revisionNo: 1,
      protocolType: "a2a",
      protocolContractRevision: "a2a@0.3.0",
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest: `sha256:${"b".repeat(64)}`,
      endpointRef: `https://runtime.example.test/${revisionId}`,
      runtimeCapabilitiesJson: [],
      identityMode: "workload_token",
      networkZone: "internal",
      configHash: `sha256:${"c".repeat(64)}`,
      revisionState: "draft",
      createdBy: "projection-test",
      agentContractSnapshotId: options.agentContractSnapshotId,
    });
    return { tenantId: tenant.id, revisionId };
  }

  it("外部登记 Revision 投影精确的 AgentContractSnapshot id", async () => {
    const tenant = await ensureDefaultTenant();
    const agent = await createAgent({
      tenantId: tenant.id,
      agentKey: `projection-agent-${randomUUID()}`,
      displayName: "Projection Agent",
      ownerUserId: randomUUID(),
    });
    const snapshot = await seedAgentContractSnapshot({
      tenantId: tenant.id,
      agentId: agent.id,
      createdBy: "projection-test",
    });
    const seeded = await seedRuntimeRevision({
      agentContractSnapshotId: snapshot.id,
    });
    const projection = await loadRuntimeRevisionAdminProjection(seeded.tenantId, seeded.revisionId);
    expect(projection).not.toBeNull();
    expect(projection?.agent_contract_snapshot_id).toBe(snapshot.id);
  });

  it("无合同快照绑定的 Revision 投影 null", async () => {
    const seeded = await seedRuntimeRevision({ agentContractSnapshotId: null });
    const projection = await loadRuntimeRevisionAdminProjection(seeded.tenantId, seeded.revisionId);
    expect(projection).not.toBeNull();
    expect(projection?.agent_contract_snapshot_id).toBeNull();
  });
});
