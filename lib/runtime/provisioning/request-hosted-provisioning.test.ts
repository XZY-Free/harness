/**
 * requestHostedProvisioning 行为测试（专题01 冻结架构，runtime-only）。
 *
 * 冻结设计：
 * - 请求权威 = (tenantId, routeScopeKey)，builtin Runtime key 固定在 Hosted Runtime
 *   Gateway，不能由请求选择（无 desiredRuntimeKey / agentId / agentRevisionId）。
 * - 请求携带非空 requesterId（供首次创建 Runtime 记录 owner）。
 * - 重复 (tenantId, routeScopeKey) 返回同一 request，不覆盖 first requester。
 * - 空白 tenantId/requesterId/routeScopeKey 在 store 写入前 fail closed（typed invalid，
 *   零 insert）。
 *
 * 用冻结形状的 fake store 驱动生产工厂，验证冻结行为成立。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HostedProvisioningRequestRow } from "../persistence/hosted-provisioning-request-record";
import type { HostedProvisioningRequestStore } from "../persistence/hosted-provisioning-request-store";
import { createRequestHostedProvisioning } from "./request-hosted-provisioning";

/** 用给定字段构造一条完整冻结行（其余 DB 列取默认值）。 */
function makeFullRow(
  overrides: Partial<HostedProvisioningRequestRow>,
): HostedProvisioningRequestRow {
  const now = new Date("2026-08-29T00:00:00.000Z");
  return {
    id: overrides.id ?? randomUUID(),
    tenantId: overrides.tenantId ?? "t-1",
    requesterId: overrides.requesterId ?? "requester-1",
    routeScopeKey: overrides.routeScopeKey ?? "prod",
    state: overrides.state ?? "pending",
    currentStep: null,
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    stepRuntimeId: null,
    stepRuntimeRevisionId: null,
    stepRuntimeArtifactId: null,
    stepRuntimeAttestationIds: null,
    stepRuntimePublicationRecordId: null,
    stepConformanceRunId: null,
    stepRouteSetId: null,
    stepRouteSetVersionNo: null,
    stepRouteId: null,
    stepRouteRevisionId: null,
    stepRouteActivationId: null,
    stepProjectionVersionNo: null,
    workflowVersion: "3.0",
    lastCompletedStep: null,
    ...overrides,
  };
}

function makeFrozenHarness() {
  const rows: HostedProvisioningRequestRow[] = [];
  let insertCalls = 0;

  const store: HostedProvisioningRequestStore = {
    async findActiveRequest({ tenantId, routeScopeKey }) {
      const found = rows.find((r) => r.tenantId === tenantId && r.routeScopeKey === routeScopeKey);
      return found ?? null;
    },
    async insert(input) {
      insertCalls++;
      const row = makeFullRow({
        id: input.id,
        tenantId: input.tenantId,
        requesterId: input.requesterId,
        routeScopeKey: input.routeScopeKey,
        state: input.state ?? "pending",
      });
      rows.push(row);
      return row;
    },
    async getById() {
      return null;
    },
    async updateState() {
      return makeFullRow({ id: "stub", state: "running" });
    },
    async claimRequests() {
      return [];
    },
    async releaseLease() {
      return;
    },
  };

  return {
    store,
    get insertCalls() {
      return insertCalls;
    },
    get rows() {
      return rows;
    },
  };
}

describe("requestHostedProvisioning（冻结 (tenantId, routeScopeKey) 权威）", () => {
  it("传入冻结参数 {tenantId, requesterId, routeScopeKey} 透传 requesterId 落库", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    const result = await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "requester-1",
      routeScopeKey: "prod",
    });

    expect(harness.insertCalls).toBe(1);
    const inserted = harness.rows[0];
    if (!inserted) throw new Error("Hosted provisioning request 未落库");
    if (!("requestId" in result)) throw new Error("合法 Hosted provisioning 请求被拒绝");
    // 冻结设计：落库 requesterId 必须为请求携带值（首次创建 Runtime 的 owner）。
    expect(inserted.requesterId).toBe("requester-1");
    // 冻结设计：请求身份不得包含 Agent 字段或 desiredRuntimeKey。
    expect(inserted).not.toHaveProperty("agentId");
    expect(inserted).not.toHaveProperty("agentRevisionId");
    expect(inserted).not.toHaveProperty("desiredRuntimeKey");
    expect(result.requestId).toBe(inserted.id);
  });

  it("空白 requesterId 在 store 写入前 fail closed（零 insert）", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    const result = await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "   ",
      routeScopeKey: "prod",
    });

    // 冻结设计：空白 requesterId 非法，不得产生任何 store 写入。
    expect(harness.insertCalls).toBe(0);
    expect(harness.rows).toHaveLength(0);
    expect(result).toMatchObject({ valid: false });
  });

  it("重复 (tenantId, routeScopeKey) 返回同一 request 且不覆盖 first requester", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    const first = await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "requester-first",
      routeScopeKey: "prod",
    });
    const second = await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "requester-second",
      routeScopeKey: "prod",
    });

    // 幂等：同 (tenant, scope) 只落库一次，返回同一 requestId。
    expect(harness.insertCalls).toBe(1);
    expect(harness.rows).toHaveLength(1);
    if (!("requestId" in first) || !("requestId" in second)) {
      throw new Error("合法幂等请求被拒绝");
    }
    expect(second.requestId).toBe(first.requestId);
    // 不覆盖 first requester。
    expect(harness.rows[0]?.requesterId).toBe("requester-first");
  });

  it("不同 tenant 或不同 routeScopeKey 创建独立请求", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "requester-1",
      routeScopeKey: "prod",
    });
    await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "requester-1",
      routeScopeKey: "staging",
    });
    await requestHostedProvisioning({
      tenantId: "t-2",
      requesterId: "requester-1",
      routeScopeKey: "prod",
    });

    expect(harness.insertCalls).toBe(3);
    expect(harness.rows).toHaveLength(3);
  });
});

describe("requestHostedProvisioning 参数校验（store 写入前 fail closed）", () => {
  it("空白 tenantId 零 insert", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    const result = await requestHostedProvisioning({
      tenantId: "",
      requesterId: "requester-1",
      routeScopeKey: "prod",
    });

    expect(harness.insertCalls).toBe(0);
    expect(harness.rows).toHaveLength(0);
    expect(result).toMatchObject({ valid: false });
  });

  it("空白 routeScopeKey 零 insert", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    const result = await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "requester-1",
      routeScopeKey: "  ",
    });

    expect(harness.insertCalls).toBe(0);
    expect(harness.rows).toHaveLength(0);
    expect(result).toMatchObject({ valid: false });
  });

  it("空 requesterId（空串）零 insert", async () => {
    const harness = makeFrozenHarness();
    const requestHostedProvisioning = createRequestHostedProvisioning({
      store: harness.store,
    });

    const result = await requestHostedProvisioning({
      tenantId: "t-1",
      requesterId: "",
      routeScopeKey: "prod",
    });

    expect(harness.insertCalls).toBe(0);
    expect(harness.rows).toHaveLength(0);
    expect(result).toMatchObject({ valid: false });
  });
});
