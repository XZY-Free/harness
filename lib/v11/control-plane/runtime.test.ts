/**
 * S03-C02：V11 Runtime 修订模型集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - runtime-queries：createRuntime/getRuntimeById/getRuntimeByKey/listRuntimes/updateRuntimeLifecycle/setCurrentRuntimeRevision/softDeleteRuntime。
 * - runtime-revision-queries：createDraft/updateDraft/publish/withdraw/get/getByRuntime/getLatestPublished。
 * - runtime-conformance：validateConformanceGate（4 mandatory case）/ isCapabilitySubset / ConformanceGateError。
 * - 不可变性约束：published 业务内容不可改；withdrawn 不删除历史引用；revisionNo 单调递增。
 * - 生命周期约束：retired 终态不可变更；软删除仅 draft/disabled 允许。
 * - 乐观锁：versionNo 不匹配返回 null/false；publishRuntimeRevision 冲突抛 RuntimeVersionConflictError。
 * - Conformance 门禁：mandatory case 失败 → publish 抛 ConformanceGateError，Revision 保持 draft。
 * - 跨租户隔离：getRuntimeById/listRuntimes 按 tenantId 过滤。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  type ConformanceCaseResult,
  ConformanceGateError,
  MANDATORY_GATE_CASES,
  isCapabilitySubset,
  validateConformanceGate,
} from "@/lib/v11/control-plane/runtime-conformance";
import {
  RuntimeLifecycleError,
  createRuntime,
  getRuntimeById,
  getRuntimeByKey,
  listRuntimes,
  setCurrentRuntimeRevision,
  softDeleteRuntime,
  updateRuntimeLifecycle,
} from "@/lib/v11/control-plane/runtime-queries";
import {
  RuntimeRevisionImmutableError,
  RuntimeRevisionNotFoundError,
  RuntimeRevisionStateError,
  RuntimeVersionConflictError,
  createDraftRuntimeRevision,
  getLatestPublishedRuntimeRevision,
  getRevisionsByRuntime,
  getRuntimeRevisionById,
  publishRuntimeRevision,
  updateDraftRuntimeRevisionContent,
  withdrawRuntimeRevision,
} from "@/lib/v11/control-plane/runtime-revision-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 ─────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "runtime-owner-001",
    email: "runtime-owner@example.com",
    displayName: "Runtime Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "runtime-owner-001",
    displayName: "Runtime Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildDraftParams(
  tenantId: string,
  runtimeId: string,
  createdBy: string,
  overrides: Partial<{
    protocolType: string;
    endpointRef: string;
    runtimeArtifactRef: string;
    configHash: string;
    identityMode: string;
    networkZone: string;
  }> = {},
) {
  return {
    tenantId,
    runtimeId,
    protocolType: overrides.protocolType ?? "agent_runtime_protocol",
    endpointRef: overrides.endpointRef ?? "connection://doubao-prod",
    runtimeArtifactRef: overrides.runtimeArtifactRef ?? "oci://registry/runtime@sha256:abc",
    runtimeCapabilitiesJson: { steer: true, cancel: true, event_stream: true, tool_call: true },
    identityMode: overrides.identityMode ?? "workload_token",
    networkZone: overrides.networkZone ?? "internal",
    configHash: overrides.configHash ?? "sha256:config_v1",
    createdBy,
  };
}

/** 构造全部 mandatory case 通过的 conformance 结果。 */
function passingConformanceResults(): ConformanceCaseResult[] {
  return MANDATORY_GATE_CASES.map((caseId) => ({ caseId, passed: true }));
}

/** 构造指定 mandatory case 失败的 conformance 结果。 */
function failingConformanceResults(
  failCase: (typeof MANDATORY_GATE_CASES)[number],
): ConformanceCaseResult[] {
  return MANDATORY_GATE_CASES.map((caseId) => ({
    caseId,
    passed: caseId !== failCase,
    reason: caseId === failCase ? "模拟探测失败" : undefined,
  }));
}

// ─── runtime-conformance（纯逻辑）──────────────────────

describe("V11 runtime-conformance（纯逻辑）", () => {
  it("validateConformanceGate 全部 mandatory 通过 → passed=true", () => {
    const result = validateConformanceGate(passingConformanceResults());
    expect(result.passed).toBe(true);
    expect(result.failedCases).toHaveLength(0);
  });

  it("validateConformanceGate 缺失一个 mandatory case → passed=false", () => {
    const results = passingConformanceResults().filter(
      (r) => r.caseId !== "event-batch-idempotent",
    );
    const result = validateConformanceGate(results);
    expect(result.passed).toBe(false);
    expect(result.failedCases).toContain("event-batch-idempotent");
  });

  it("validateConformanceGate 一个 mandatory case passed=false → passed=false", () => {
    const result = validateConformanceGate(
      failingConformanceResults("credential-never-in-model-data"),
    );
    expect(result.passed).toBe(false);
    expect(result.failedCases).toContain("credential-never-in-model-data");
  });

  it("validateConformanceGate 空 results → passed=false（4 个全缺失）", () => {
    const result = validateConformanceGate([]);
    expect(result.passed).toBe(false);
    expect(result.failedCases).toHaveLength(4);
  });

  it("validateConformanceGate 非 mandatory case 不影响门禁", () => {
    const results: ConformanceCaseResult[] = [
      ...passingConformanceResults(),
      { caseId: "steer-requires-ack", passed: false, reason: "optional case 失败" },
    ];
    const result = validateConformanceGate(results);
    expect(result.passed).toBe(true);
  });

  it("MANDATORY_GATE_CASES 恰好 4 个基础用例", () => {
    expect(MANDATORY_GATE_CASES).toHaveLength(4);
    expect([...MANDATORY_GATE_CASES]).toEqual([
      "dispatch-binds-immutable-config",
      "event-batch-idempotent",
      "cancel-request-not-terminal",
      "credential-never-in-model-data",
    ]);
  });

  it("isCapabilitySubset 子集满足 → satisfied=true", () => {
    const result = isCapabilitySubset(["steer", "cancel"], ["steer", "cancel", "event_stream"]);
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("isCapabilitySubset 缺失能力 → satisfied=false + missing 列表", () => {
    const result = isCapabilitySubset(["steer", "cancel", "memory"], ["steer", "cancel"]);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["memory"]);
  });

  it("isCapabilitySubset 空 required → satisfied=true", () => {
    const result = isCapabilitySubset([], ["steer"]);
    expect(result.satisfied).toBe(true);
  });

  it("isCapabilitySubset 空 runtime + 非空 required → satisfied=false", () => {
    const result = isCapabilitySubset(["steer"], []);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["steer"]);
  });

  it("ConformanceGateError 包含 failedCases", () => {
    const error = new ConformanceGateError(["event-batch-idempotent"]);
    expect(error.failedCases).toEqual(["event-batch-idempotent"]);
    expect(error.message).toContain("event-batch-idempotent");
  });
});

// ─── runtime-queries（DB）──────────────────────────────

describe("V11 runtime-queries", () => {
  let tenantId: string;
  let ownerId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
  });

  it("createRuntime 创建稳定 Runtime 身份（默认 lifecycle=draft）", async () => {
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Doubao Hosted Runtime",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    expect(runtime.id).toBeDefined();
    expect(runtime.tenantId).toBe(tenantId);
    expect(runtime.runtimeKey).toBe("doubao-hosted");
    expect(runtime.runtimeKind).toBe("hosted");
    expect(runtime.ownerUserId).toBe(ownerId);
    expect(runtime.lifecycleState).toBe("draft");
    expect(runtime.currentRevisionId).toBeNull();
    expect(runtime.versionNo).toBe(1);
    expect(runtime.deletedAt).toBeNull();
  });

  it("createRuntime 同租户同 runtimeKey 抛唯一约束冲突", async () => {
    await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    await expect(
      createRuntime({
        tenantId,
        runtimeKey: "doubao-hosted",
        displayName: "重复",
        runtimeKind: "external",
        ownerUserId: ownerId,
      }),
    ).rejects.toThrow();
  });

  it("createRuntime external kind 正常创建", async () => {
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "external-a2a",
      displayName: "External A2A Runtime",
      runtimeKind: "external",
      ownerUserId: ownerId,
    });
    expect(runtime.runtimeKind).toBe("external");
  });

  it("getRuntimeById 存在时返回记录", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const found = await getRuntimeById(tenantId, created.id);
    expect(found?.id).toBe(created.id);
  });

  it("getRuntimeById 不存在返回 null", async () => {
    expect(await getRuntimeById(tenantId, "missing-id")).toBeNull();
  });

  it("getRuntimeById 跨租户隔离", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    expect(await getRuntimeById("other-tenant", created.id)).toBeNull();
  });

  it("getRuntimeByKey 按 key 查询", async () => {
    await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const found = await getRuntimeByKey(tenantId, "doubao-hosted");
    expect(found?.runtimeKey).toBe("doubao-hosted");
  });

  it("listRuntimes 返回租户内所有 Runtime（不含软删）", async () => {
    await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    await createRuntime({
      tenantId,
      runtimeKey: "external-a2a",
      displayName: "Runtime B",
      runtimeKind: "external",
      ownerUserId: ownerId,
    });
    const list = await listRuntimes(tenantId);
    expect(list).toHaveLength(2);
  });

  it("listRuntimes 按 lifecycleState 过滤", async () => {
    await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    await createRuntime({
      tenantId,
      runtimeKey: "external-a2a",
      displayName: "Runtime B",
      runtimeKind: "external",
      ownerUserId: ownerId,
      lifecycleState: "enabled",
    });
    const enabled = await listRuntimes(tenantId, { lifecycleState: "enabled" });
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.runtimeKey).toBe("external-a2a");
  });

  it("listRuntimes 跨租户隔离", async () => {
    await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    expect(await listRuntimes("other-tenant")).toHaveLength(0);
  });

  it("updateRuntimeLifecycle draft → enabled（versionNo 递增）", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const updated = await updateRuntimeLifecycle(tenantId, created.id, "enabled", 1);
    expect(updated?.lifecycleState).toBe("enabled");
    expect(updated?.versionNo).toBe(2);
  });

  it("updateRuntimeLifecycle retired 终态不可再变更", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    await updateRuntimeLifecycle(tenantId, created.id, "disabled", 1);
    await updateRuntimeLifecycle(tenantId, created.id, "retired", 2);
    await expect(updateRuntimeLifecycle(tenantId, created.id, "enabled", 3)).rejects.toThrow(
      RuntimeLifecycleError,
    );
  });

  it("updateRuntimeLifecycle 乐观锁冲突返回 null", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    expect(await updateRuntimeLifecycle(tenantId, created.id, "enabled", 999)).toBeNull();
  });

  it("setCurrentRuntimeRevision 回填 currentRevisionId", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    const updated = await setCurrentRuntimeRevision(tenantId, created.id, "rev_1", 1);
    expect(updated?.currentRevisionId).toBe("rev_1");
    expect(updated?.versionNo).toBe(2);
  });

  it("softDeleteRuntime draft 状态允许软删", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    expect(await softDeleteRuntime(tenantId, created.id, 1)).toBe(true);
    expect(await listRuntimes(tenantId)).toHaveLength(0);
    expect(await listRuntimes(tenantId, { includeDeleted: true })).toHaveLength(1);
  });

  it("softDeleteRuntime enabled 状态拒绝", async () => {
    const created = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Runtime A",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    await updateRuntimeLifecycle(tenantId, created.id, "enabled", 1);
    await expect(softDeleteRuntime(tenantId, created.id, 2)).rejects.toThrow(RuntimeLifecycleError);
  });
});

// ─── runtime-revision-queries（DB）─────────────────────

describe("V11 runtime-revision-queries", () => {
  let tenantId: string;
  let ownerId: string;
  let runtimeId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Doubao Hosted Runtime",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    runtimeId = runtime.id;
  });

  it("createDraftRuntimeRevision 创建 draft Revision（revisionNo=1）", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    expect(rev.id).toBeDefined();
    expect(rev.runtimeId).toBe(runtimeId);
    expect(rev.revisionNo).toBe(1);
    expect(rev.revisionState).toBe("draft");
    expect(rev.protocolType).toBe("agent_runtime_protocol");
    expect(rev.publishedAt).toBeNull();
    expect(rev.runtimeCapabilitiesJson).toEqual({
      steer: true,
      cancel: true,
      event_stream: true,
      tool_call: true,
    });
  });

  it("createDraftRuntimeRevision revisionNo 单调递增", async () => {
    const r1 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r2 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r3 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    expect(r1.revisionNo).toBe(1);
    expect(r2.revisionNo).toBe(2);
    expect(r3.revisionNo).toBe(3);
  });

  it("createDraftRuntimeRevision 不同 Runtime revisionNo 独立", async () => {
    const otherRuntime = await createRuntime({
      tenantId,
      runtimeKey: "external-a2a",
      displayName: "External Runtime",
      runtimeKind: "external",
      ownerUserId: ownerId,
    });
    const r1a = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r1b = await createDraftRuntimeRevision(
      buildDraftParams(tenantId, otherRuntime.id, ownerId),
    );
    expect(r1a.revisionNo).toBe(1);
    expect(r1b.revisionNo).toBe(1);
  });

  it("updateDraftRuntimeRevisionContent 修改 draft 业务内容", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const updated = await updateDraftRuntimeRevisionContent(rev.id, {
      configHash: "sha256:config_v2",
      runtimeCapabilitiesJson: { steer: false, cancel: true },
    });
    expect(updated.configHash).toBe("sha256:config_v2");
    expect(updated.runtimeCapabilitiesJson).toEqual({ steer: false, cancel: true });
  });

  it("updateDraftRuntimeRevisionContent 空 patch 返回原记录", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const updated = await updateDraftRuntimeRevisionContent(rev.id, {});
    expect(updated.id).toBe(rev.id);
    expect(updated.configHash).toBe(rev.configHash);
  });

  it("updateDraftRuntimeRevisionContent published 状态抛 ImmutableError", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, rev.id, 1, passingConformanceResults());
    await expect(
      updateDraftRuntimeRevisionContent(rev.id, { configHash: "sha256:modified" }),
    ).rejects.toThrow(RuntimeRevisionImmutableError);
  });

  it("publishRuntimeRevision conformance 门禁通过 → published + currentRevisionId 回填", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const published = await publishRuntimeRevision(
      tenantId,
      rev.id,
      1,
      passingConformanceResults(),
    );
    expect(published.revisionState).toBe("published");
    expect(published.publishedAt).not.toBeNull();

    const runtimeRow = await getRuntimeById(tenantId, runtimeId);
    expect(runtimeRow?.currentRevisionId).toBe(rev.id);
    expect(runtimeRow?.versionNo).toBe(2);
  });

  it("publishRuntimeRevision conformance 门禁失败 → 抛 ConformanceGateError，Revision 保持 draft", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await expect(
      publishRuntimeRevision(
        tenantId,
        rev.id,
        1,
        failingConformanceResults("event-batch-idempotent"),
      ),
    ).rejects.toThrow(ConformanceGateError);

    // Revision 保持 draft
    const after = await getRuntimeRevisionById(rev.id);
    expect(after?.revisionState).toBe("draft");
    expect(after?.publishedAt).toBeNull();

    // Runtime.currentRevisionId 未回填
    const runtimeRow = await getRuntimeById(tenantId, runtimeId);
    expect(runtimeRow?.currentRevisionId).toBeNull();
  });

  it("publishRuntimeRevision conformance 缺失 mandatory case → 抛 ConformanceGateError", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    // 只提交 3 个（缺 credential-never-in-model-data）
    const partialResults = passingConformanceResults().filter(
      (r) => r.caseId !== "credential-never-in-model-data",
    );
    await expect(publishRuntimeRevision(tenantId, rev.id, 1, partialResults)).rejects.toThrow(
      ConformanceGateError,
    );
  });

  it("publishRuntimeRevision conformance 空 results → 抛 ConformanceGateError（4 个全缺）", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const error = await publishRuntimeRevision(tenantId, rev.id, 1, []).catch((e) => e);
    expect(error).toBeInstanceOf(ConformanceGateError);
    expect(error.failedCases).toHaveLength(4);
  });

  it("publishRuntimeRevision published 状态再 publish 抛 StateError", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, rev.id, 1, passingConformanceResults());
    await expect(
      publishRuntimeRevision(tenantId, rev.id, 2, passingConformanceResults()),
    ).rejects.toThrow(RuntimeRevisionStateError);
  });

  it("publishRuntimeRevision Runtime 乐观锁冲突抛 VersionConflictError", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await expect(
      publishRuntimeRevision(tenantId, rev.id, 999, passingConformanceResults()),
    ).rejects.toThrow(RuntimeVersionConflictError);
    // 但 Revision 已 published（conformance 通过后写入了 published）
    const after = await getRuntimeRevisionById(rev.id);
    expect(after?.revisionState).toBe("published");
  });

  it("withdrawRuntimeRevision published → withdrawn", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const published = await publishRuntimeRevision(
      tenantId,
      rev.id,
      1,
      passingConformanceResults(),
    );
    const withdrawn = await withdrawRuntimeRevision(rev.id);
    expect(withdrawn.revisionState).toBe("withdrawn");
    expect(withdrawn.configHash).toBe(published.configHash);
    expect(withdrawn.publishedAt).toEqual(published.publishedAt);
  });

  it("withdrawRuntimeRevision draft 状态抛 StateError", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await expect(withdrawRuntimeRevision(rev.id)).rejects.toThrow(RuntimeRevisionStateError);
  });

  it("getRevisionsByRuntime 按 revisionNo 降序返回", async () => {
    const r1 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r2 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r3 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const list = await getRevisionsByRuntime(runtimeId);
    expect(list.map((r) => r.revisionNo)).toEqual([3, 2, 1]);
    expect(list[0]?.id).toBe(r3.id);
    expect(list[2]?.id).toBe(r1.id);
  });

  it("getLatestPublishedRuntimeRevision 返回最大 revisionNo 的 published", async () => {
    const r1 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r2 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, r1.id, 1, passingConformanceResults());
    // r1 publish 后 Runtime.versionNo=2，r2 publish 需用 versionNo=2
    await publishRuntimeRevision(tenantId, r2.id, 2, passingConformanceResults());
    const latest = await getLatestPublishedRuntimeRevision(runtimeId);
    expect(latest?.id).toBe(r2.id);
    expect(latest?.revisionNo).toBe(2);
  });

  it("getLatestPublishedRuntimeRevision 排除 withdrawn", async () => {
    const r1 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const r2 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, r1.id, 1, passingConformanceResults());
    await publishRuntimeRevision(tenantId, r2.id, 2, passingConformanceResults());
    await withdrawRuntimeRevision(r2.id);
    const latest = await getLatestPublishedRuntimeRevision(runtimeId);
    expect(latest?.id).toBe(r1.id);
  });
});

// ─── 阶段验收场景（S03-W02）────────────────────────────

describe("V11 S03-W02 阶段验收场景", () => {
  let tenantId: string;
  let ownerId: string;
  let runtimeId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const runtime = await createRuntime({
      tenantId,
      runtimeKey: "doubao-hosted",
      displayName: "Doubao Hosted Runtime",
      runtimeKind: "hosted",
      ownerUserId: ownerId,
    });
    runtimeId = runtime.id;
  });

  it("Runtime 制品/能力变化 → 生成新 Revision，旧 Revision 不可变", async () => {
    const r1 = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, r1.id, 1, passingConformanceResults());
    // 制品变化生成新 Revision
    const r2 = await createDraftRuntimeRevision(
      buildDraftParams(tenantId, runtimeId, ownerId, {
        runtimeArtifactRef: "oci://registry/runtime@sha256:v2",
        configHash: "sha256:config_v2",
      }),
    );
    await publishRuntimeRevision(tenantId, r2.id, 2, passingConformanceResults());
    expect(r2.revisionNo).toBe(2);
    // 旧 Revision r1 业务内容不可变
    await expect(
      updateDraftRuntimeRevisionContent(r1.id, { configHash: "sha256:modified" }),
    ).rejects.toThrow(RuntimeRevisionImmutableError);
  });

  it("published Revision 业务内容不可修改（capabilities/protocolType/endpointRef 等）", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, rev.id, 1, passingConformanceResults());
    await expect(
      updateDraftRuntimeRevisionContent(rev.id, {
        runtimeCapabilitiesJson: { modified: true },
        protocolType: "a2a",
        endpointRef: "connection://modified",
        runtimeArtifactRef: "oci://modified",
        identityMode: "api_key",
        networkZone: "dmz",
        configHash: "sha256:modified",
      }),
    ).rejects.toThrow(RuntimeRevisionImmutableError);
  });

  it("withdrawn Revision 不删除历史引用（仍可查询）", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    await publishRuntimeRevision(tenantId, rev.id, 1, passingConformanceResults());
    await withdrawRuntimeRevision(rev.id);
    const found = await getRuntimeRevisionById(rev.id);
    expect(found).not.toBeNull();
    expect(found?.revisionState).toBe("withdrawn");
    const list = await getRevisionsByRuntime(runtimeId);
    expect(list.find((r) => r.id === rev.id)).toBeDefined();
  });

  it("Conformance 门禁失败 → Revision 不可路由（保持 draft，currentRevisionId 未回填）", async () => {
    const rev = await createDraftRuntimeRevision(buildDraftParams(tenantId, runtimeId, ownerId));
    const error = await publishRuntimeRevision(
      tenantId,
      rev.id,
      1,
      failingConformanceResults("cancel-request-not-terminal"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ConformanceGateError);
    // Revision 仍为 draft
    const after = await getRuntimeRevisionById(rev.id);
    expect(after?.revisionState).toBe("draft");
    // Runtime 不可路由（currentRevisionId 未回填）
    const runtimeRow = await getRuntimeById(tenantId, runtimeId);
    expect(runtimeRow?.currentRevisionId).toBeNull();
  });

  it("能力子集校验：Agent required ⊆ Runtime capabilities", () => {
    // Runtime 提供 steer/cancel/event_stream/tool_call
    const runtimeCaps = ["steer", "cancel", "event_stream", "tool_call"];
    // Agent 需要 event_stream + steer → 满足
    const ok = isCapabilitySubset(["event_stream", "steer"], runtimeCaps);
    expect(ok.satisfied).toBe(true);
    // Agent 需要 memory → 不满足
    const fail = isCapabilitySubset(["event_stream", "memory"], runtimeCaps);
    expect(fail.satisfied).toBe(false);
    expect(fail.missing).toEqual(["memory"]);
  });
});
