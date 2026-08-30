/**
 * RouteEligibilityResolutionStore MySQL 集成测试（真实 MySQL 8）。
 *
 * 专题01 冻结架构（01 §4.D）：
 * - RouteEligibilityProjection 是运行时唯一 Resolver 数据源，已携带 targetKind/targetIdentity，
 *   Agent 与 Runtime 证据组互斥（target 不相关的一组全 NULL）。
 * - Resolver 查询必须按显式 (tenantId,targetKind,targetIdentity,routeScopeKey,eligible) 过滤；
 *   runtime 不得用 agentId IS NULL 代替 target；agent 不可只按 agentId 不验 targetKind/identity。
 * - Agent 候选只携带 Agent target 事实与 Agent 证据；Runtime 候选只携带 Runtime 事实与证据。
 * - 投影缺失对应 target 组时 fail-closed（过滤或抛明确错误），不得默认/补齐。
 *
 * 当前 mysql-route-eligibility-resolution-store.ts 把 Runtime 证据强加给所有投影（
 * buildControlPlaneEvidence 无条件要求 runtimeConfigDigest/runtimeTargetDigest/...），
 * 对 Agent 投影（runtime 组全 NULL）会抛错、无法返回 Agent 候选 —— 以下用例锁定该实现已过期。
 * 必须使用真实 DB（resetDatabase），不可 mock schema。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import {
  type NewRouteEligibilityProjectionRecord,
  routeEligibilityProjection,
} from "@/lib/routes/projection/route-eligibility-projection-record";
import { beforeEach, describe, expect, it } from "vitest";
import { mysqlRouteEligibilityResolutionStore } from "./mysql-route-eligibility-resolution-store";

const NOW = new Date("2026-08-29T00:00:00.000Z");

function sha(prefix: string, fill: string): string {
  return `${prefix}:${fill.repeat(64)}`;
}

/** 合法 Agent 目标 eligible 投影（冻结）：runtime 组全 NULL、targetIdentity=agentId。 */
function agentProjection(overrides: Record<string, unknown> = {}) {
  return {
    routeId: randomUUID(),
    tenantId: "resolver-store-tenant",
    targetKind: "agent",
    targetIdentity: "agent-1",
    agentId: "agent-1",
    routeSetId: randomUUID(),
    routeScopeKey: "prod",
    routeSetVersionNo: 1,
    routeRevisionId: randomUUID(),
    routeRevisionNo: 1,
    routeActivationId: randomUUID(),
    routeActivationSequence: 1,
    activationState: "active",
    routeGroupId: "primary",
    selectorDigest: sha("sha256", "a"),
    eligibilityConditionsJson: {},
    specificity: 0,
    priorityNo: 10,
    trafficWeight: 10_000,
    effectiveFrom: null,
    effectiveUntil: null,
    // Agent 组
    agentRevisionId: "agent-rev-1",
    agentEndpointRef: "https://agent.example.com/capability",
    agentIdentityMode: "none",
    agentCredentialRefId: null,
    agentNetworkZone: "cn-north",
    agentRevisionState: "published",
    agentLifecycleState: "enabled",
    agentPublicationActive: 1,
    agentEvidenceValid: 1,
    agentPublicationRecordId: "agent-pub-1",
    agentContractSnapshotId: "contract-1",
    agentContractDigest: sha("sha256", "c"),
    agentContextDigest: sha("sha256", "d"),
    // Runtime 组（agent target 必须全 NULL）
    runtimeRevisionId: null,
    runtimeRevisionState: null,
    runtimeLifecycleState: null,
    runtimePublicationActive: null,
    runtimeEvidenceValid: null,
    runtimeConformanceValid: null,
    runtimeEvidenceKind: null,
    runtimeArtifactDigest: null,
    runtimeConfigDigest: null,
    runtimeTargetDigest: null,
    runtimePublicationRecordId: null,
    runtimeAttestationIds: null,
    conformanceRunId: null,
    runtimeArtifactId: null,
    // 公共
    policyRevisionId: null,
    policyRevisionState: null,
    capabilityCompatibilityDigest: null,
    routeContentDigest: sha("sha256", "e"),
    sourceEventId: null,
    sourceAggregateVersion: null,
    invalidReason: null,
    eligibilityState: "eligible",
    projectionContentDigest: sha("sha256", "f"),
    projectionVersionNo: 1,
    lastRebuiltAt: NOW,
    ...overrides,
  };
}

/** 合法 Runtime 目标 eligible 投影（冻结）：agent 组全 NULL、targetIdentity='runtime'。 */
function runtimeProjection(overrides: Record<string, unknown> = {}) {
  return {
    ...agentProjection({
      targetKind: "runtime",
      targetIdentity: "runtime",
      agentId: null,
      // Agent 组全 NULL
      agentRevisionId: null,
      agentEndpointRef: null,
      agentIdentityMode: null,
      agentCredentialRefId: null,
      agentNetworkZone: null,
      agentRevisionState: null,
      agentLifecycleState: null,
      agentPublicationActive: null,
      agentEvidenceValid: null,
      agentPublicationRecordId: null,
      agentContractSnapshotId: null,
      agentContractDigest: null,
      agentContextDigest: null,
      // Runtime 组
      runtimeRevisionId: "rt-rev-1",
      runtimeRevisionState: "published",
      runtimeLifecycleState: "enabled",
      runtimePublicationActive: 1,
      runtimeEvidenceValid: 1,
      runtimeConformanceValid: 1,
      runtimeEvidenceKind: "hosted_artifact",
      runtimeArtifactDigest: sha("sha256", "x"),
      runtimeConfigDigest: sha("sha256", "y"),
      runtimeTargetDigest: sha("sha256", "z"),
      runtimePublicationRecordId: "rt-pub-1",
      runtimeAttestationIds: ["att-1"],
      conformanceRunId: "conformance-1",
      runtimeArtifactId: "rt-artifact-1",
      capabilityCompatibilityDigest: sha("sha256", "b"),
    }),
    ...overrides,
  };
}

async function insertRow(row: Record<string, unknown>): Promise<void> {
  await db
    .insert(routeEligibilityProjection)
    .values(row as unknown as NewRouteEligibilityProjectionRecord);
}

async function loadCandidates(
  input: Parameters<typeof mysqlRouteEligibilityResolutionStore.loadCandidates>[0],
) {
  return mysqlRouteEligibilityResolutionStore.loadCandidates(input);
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

describe("mysqlRouteEligibilityResolutionStore target-specific 过滤与证据（专题01 冻结架构）", () => {
  it("[RED] agent A eligible 投影仅被 agent A resolver 返回；runtime resolver 仅返回 runtime 投影", async () => {
    // 同 tenant/scope：agent A、agent B、runtime 三个 eligible 投影共存。
    const agentA = agentProjection({ targetIdentity: "agent-1", agentId: "agent-1" });
    const agentB = agentProjection({
      routeId: randomUUID(),
      targetIdentity: "agent-2",
      agentId: "agent-2",
      agentRevisionId: "agent-rev-2",
    });
    const rt = runtimeProjection({ routeId: randomUUID() });
    await insertRow(agentA);
    await insertRow(agentB);
    await insertRow(rt);

    // agent A resolver → 只返回 agent A，绝不返回 agent B / runtime。
    const agentARows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-1" },
      routeScopeKey: "prod",
    });
    expect(agentARows.map((c) => c.deploymentRouteId)).toEqual([agentA.routeId]);

    // runtime resolver → 只返回 runtime，绝不返回 agent A/B。
    const rtRows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "runtime" },
      routeScopeKey: "prod",
    });
    expect(rtRows.map((c) => c.deploymentRouteId)).toEqual([rt.routeId]);

    // agent B resolver → 只返回 agent B。
    const agentBRows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-2" },
      routeScopeKey: "prod",
    });
    expect(agentBRows.map((c) => c.deploymentRouteId)).toEqual([agentB.routeId]);
  });

  it("[RED] wrong targetIdentity（未播种的 agent）不返回任何候选", async () => {
    await insertRow(agentProjection());
    const rows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-ghost" },
      routeScopeKey: "prod",
    });
    expect(rows).toEqual([]);
  });

  it("[RED] Agent 候选 target/evidence 不含任何 Runtime 字段", async () => {
    await insertRow(agentProjection());
    const rows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-1" },
      routeScopeKey: "prod",
    });
    expect(rows).toHaveLength(1);
    const [candidate] = rows;
    if (!candidate) throw new Error("Agent 候选缺失");
    // target 是 agent 判别，无 runtimeRevisionId。
    expect(candidate.target.kind).toBe("agent");
    // 证据是 agent 判别，不含 runtime 发布/conformance/artifact 事实。
    expect(candidate.controlPlaneEvidence.kind).toBe("agent");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("runtimeArtifactId");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("runtimeConfigDigest");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("runtimeTargetDigest");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("runtimePublicationRecordId");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("conformanceRunId");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("runtimeAttestationIds");
  });

  it("[RED] Runtime 候选 target/evidence 不含任何 Agent 字段", async () => {
    await insertRow(runtimeProjection());
    const rows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "runtime" },
      routeScopeKey: "prod",
    });
    expect(rows).toHaveLength(1);
    const [candidate] = rows;
    if (!candidate) throw new Error("Runtime 候选缺失");
    expect(candidate.target.kind).toBe("runtime");
    expect(candidate.controlPlaneEvidence.kind).toBe("runtime");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("agentRevisionId");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("agentContractSnapshotId");
    expect(candidate.controlPlaneEvidence).not.toHaveProperty("agentPublicationRecordId");
  });

  it("[RED] agent 投影（runtime 组全 NULL）必须按 agent 返回，不得强行补齐 Runtime 证据", async () => {
    // 冻结架构：agent target 投影 runtime 组全 NULL。Resolver 应原样返回 agent 候选（Agent 证据），
    // 禁止把 Runtime evidence 强加/补齐到 agent 投影。
    await insertRow(agentProjection());
    const rows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-1" },
      routeScopeKey: "prod",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.controlPlaneEvidence.kind).toBe("agent");
  });

  it("runtime 投影缺少必需 Runtime 证据时 fail-closed（不形成候选）", async () => {
    // runtime target 证据 all-or-nothing：缺 runtimeConfigDigest → 无法构造 Runtime 证据 → 必须失败。
    await insertRow(runtimeProjection({ runtimeConfigDigest: null }));
    await expect(
      loadCandidates({
        tenantId: "resolver-store-tenant",
        target: { kind: "runtime" },
        routeScopeKey: "prod",
      }),
    ).rejects.toThrow();
  });

  it("runtime 投影 capabilityCompatibilityDigest=null 时 fail-closed（不得 fallback 空串）", async () => {
    // capabilityCompatibilityDigest 是 runtime projection 的必需字段（§6）；缺失不得回退 ""。
    await insertRow(runtimeProjection({ capabilityCompatibilityDigest: null }));
    await expect(
      loadCandidates({
        tenantId: "resolver-store-tenant",
        target: { kind: "runtime" },
        routeScopeKey: "prod",
      }),
    ).rejects.toThrow();
  });

  it("[RED] 正整数 projectionVersionNo 从投影保留到候选", async () => {
    await insertRow(agentProjection({ projectionVersionNo: 7 }));
    const rows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-1" },
      routeScopeKey: "prod",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectionVersionNo).toBe(7);
  });

  it("[RED] projectionVersionNo 为 0 的投影不得形成 resolved success（policy fail-closed）", async () => {
    // projectionVersionNo 是 projection-only 候选的必填正整数；0/缺失/负不可 resolved。
    // DB 列为 unsigned NOT NULL，故用 0 演示；negative 由 unsigned 列拒绝。
    await insertRow(agentProjection({ projectionVersionNo: 0 }));
    const rows = await loadCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-1" },
      routeScopeKey: "prod",
    });
    // 候选已带 0 → 交给 resolveRouteCandidates 必须 unresolved（no_eligible_route）。
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectionVersionNo).toBe(0);
    const { resolveRouteCandidates } = await import("@/lib/routes/domain/route-resolution-policy");
    const outcome = resolveRouteCandidates({
      tenantId: "resolver-store-tenant",
      target: { kind: "agent", agentId: "agent-1" },
      routeScopeKey: "prod",
      businessKey: { threadId: "t" },
      attributes: {},
      candidates: rows,
      now: NOW,
    });
    expect(outcome.status).toBe("unresolved");
  });
});
