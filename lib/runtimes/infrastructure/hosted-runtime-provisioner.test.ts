import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { artifact, artifactAttestation } from "@/lib/artifacts/persistence/artifact-record";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { getEffectiveRoutes } from "@/lib/routes/application/deployment-route-service";
import { routeActivation, routeRevision } from "@/lib/routes/persistence/route-revision-record";
import { resetHostedControlPlaneEvidenceProvider } from "@/lib/runtimes/domain/hosted-control-plane-evidence";
import { ensureHostedRouteForAgent } from "@/lib/runtimes/infrastructure/hosted-runtime-provisioner";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { installTrustedHostedControlPlaneEvidenceForTest } from "@/lib/v11/test-support/trusted-hosted-control-plane-evidence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let restoreEvidence: () => void;

beforeEach(async () => {
  await resetDatabase(db);
  restoreEvidence = installTrustedHostedControlPlaneEvidenceForTest();
});

afterEach(() => {
  restoreEvidence();
});

async function seedAgent(externalSubject: string) {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject,
    email: `${externalSubject}@example.com`,
    displayName: "Hosted Route Owner",
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "default",
    displayName: "默认助手",
    ownerUserId: owner.id,
    lifecycleState: "enabled",
  });
  return { tenant, agent };
}

describe("ensureHostedRouteForAgent", () => {
  it("经正式证据和发布门禁创建可调度路由，重复调用不重复创建", async () => {
    const { tenant, agent } = await seedAgent("hosted-route-owner");

    const first = await ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id });
    const second = await ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id });
    const routes = await getEffectiveRoutes(tenant.id, agent.id, "default");

    expect(second.routeId).toBe(first.routeId);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: first.routeId,
      agentRevisionId: first.agentRevisionId,
      runtimeRevisionId: first.runtimeRevisionId,
      routeState: "enabled",
    });
    expect(await db.select().from(artifact)).toHaveLength(2);
    expect(await db.select().from(artifactAttestation)).toHaveLength(2);
    expect(await db.select().from(publicationRecord)).toHaveLength(2);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(runtimeConformanceCaseResult)).toHaveLength(16);
    expect(await db.select().from(routeRevision)).toHaveLength(1);
    expect(await db.select().from(routeActivation)).toHaveLength(1);
  });

  it("两个并发供应请求收敛到同一套权威事实", async () => {
    restoreEvidence();
    restoreEvidence = installTrustedHostedControlPlaneEvidenceForTest({
      delaySecondAgentEvidenceMs: 1_000,
    });
    const { tenant, agent } = await seedAgent("hosted-route-concurrent-owner");

    const [first, second] = await Promise.all([
      ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id }),
      ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id }),
    ]);

    expect(second).toEqual(first);
    expect(await db.select().from(artifactAttestation)).toHaveLength(2);
    expect(await db.select().from(publicationRecord)).toHaveLength(2);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(routeRevision)).toHaveLength(1);
    expect(await db.select().from(routeActivation)).toHaveLength(1);
  });

  it("未配置可信证据源时失败关闭且不创建发布事实", async () => {
    const { tenant, agent } = await seedAgent("hosted-route-no-evidence-owner");
    resetHostedControlPlaneEvidenceProvider();

    await expect(
      ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id }),
    ).rejects.toThrow("Hosted 控制面证据源未配置");
    expect(await db.select().from(publicationRecord)).toHaveLength(0);
    expect(await db.select().from(routeActivation)).toHaveLength(0);
  });

  it("Runner 在 Agent 发布后失败，重试复用权威事实并继续收敛", async () => {
    restoreEvidence();
    restoreEvidence = installTrustedHostedControlPlaneEvidenceForTest({
      failRuntimeConformanceAttempts: 1,
    });
    const { tenant, agent } = await seedAgent("hosted-route-runner-retry-owner");

    await expect(
      ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id }),
    ).rejects.toThrow("可信 Hosted Conformance Runner 暂时不可用");
    expect(await db.select().from(publicationRecord)).toHaveLength(1);
    expect(await db.select().from(routeActivation)).toHaveLength(0);

    await expect(
      ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id }),
    ).resolves.toMatchObject({
      agentRevisionId: expect.any(String),
      runtimeRevisionId: expect.any(String),
    });
    expect(await db.select().from(artifactAttestation)).toHaveLength(2);
    expect(await db.select().from(publicationRecord)).toHaveLength(2);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(1);
    expect(await db.select().from(routeActivation)).toHaveLength(1);
  });

  it("Runtime 制品验签失败时保留失败 Attestation 且不进入发布和路由", async () => {
    restoreEvidence();
    restoreEvidence = installTrustedHostedControlPlaneEvidenceForTest({
      corruptArtifactSignatureFor: "runtime_revision",
    });
    const { tenant, agent } = await seedAgent("hosted-route-invalid-runtime-artifact-owner");

    await expect(
      ensureHostedRouteForAgent({ tenantId: tenant.id, agentId: agent.id }),
    ).rejects.toThrow("signature_invalid");
    const attestations = await db.select().from(artifactAttestation);
    expect(attestations).toHaveLength(2);
    expect(attestations.find((item) => item.artifactType === "runtime_revision")).toMatchObject({
      verificationState: "failed",
      failureCode: "signature_invalid",
    });
    expect(await db.select().from(publicationRecord)).toHaveLength(1);
    expect(await db.select().from(runtimeConformanceRun)).toHaveLength(0);
    expect(await db.select().from(routeActivation)).toHaveLength(0);
  });
});
