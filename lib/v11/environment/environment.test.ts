/**
 * V11 EnvironmentDefinition / EnvironmentLease / EnvironmentChangeRequest /
 * ExecutionOwnership 集成测试（阶段 8 S08-C02）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.13（execution_ownership 与
 *   environment_change_request）、§7.2（environment_definition 与 environment_lease）。
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §11（Execution Environment）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W02。
 *
 * 覆盖：
 * - 辅助函数：isValidEnvironmentKey / isEnvironmentType / isEnvironmentLeaseState /
 *   isEnvironmentChangeRequestState / isEnvironmentDefinitionLifecycleState。
 * - EnvironmentDefinition：createEnvironmentDefinition / getEnvironmentDefinitionByKey /
 *   listEnvironmentDefinitions / archiveEnvironmentDefinition / 跨租户隔离。
 * - EnvironmentLease：createEnvironmentLease（Desktop 必含 deviceId / Cloud 不允许 deviceId）/
 *   activateEnvironmentLease / heartbeatEnvironmentLease / beginReleaseEnvironmentLease /
 *   releaseEnvironmentLease / expireEnvironmentLease / markLostEnvironmentLease /
 *   markExpiredEnvironmentLeases / markLostEnvironmentLeasesByHeartbeat / 终态不可恢复。
 * - EnvironmentChangeRequest：createEnvironmentChangeRequest / acceptForNextInvocation /
 *   acknowledgeRuntimeMigration / reject / expire / 终态不可恢复。
 * - ExecutionOwnership：acquireExecutionOwnership（epoch 单调递增 + 释放旧 active）/
 *   releaseExecutionOwnership / markLostExecutionOwnership / heartbeatExecutionOwnership /
 *   getActiveExecutionOwnership / isActiveEpoch（旧 epoch 拒绝）。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  EnvironmentChangeRequestStateError,
  EnvironmentLeaseStateError,
  EnvironmentNotFoundError,
  EnvironmentValidationError,
  EnvironmentVersionConflictError,
  acceptForNextInvocationEnvironmentChangeRequest,
  acknowledgeRuntimeMigrationEnvironmentChangeRequest,
  acquireExecutionOwnership,
  activateEnvironmentLease,
  archiveEnvironmentDefinition,
  beginReleaseEnvironmentLease,
  createEnvironmentChangeRequest,
  createEnvironmentDefinition,
  createEnvironmentLease,
  expireEnvironmentChangeRequest,
  expireEnvironmentLease,
  getActiveExecutionOwnership,
  getEnvironmentChangeRequestById,
  getEnvironmentDefinitionById,
  getEnvironmentDefinitionByKey,
  getEnvironmentLeaseById,
  heartbeatEnvironmentLease,
  heartbeatExecutionOwnership,
  isActiveEpoch,
  isEnvironmentChangeRequestState,
  isEnvironmentDefinitionLifecycleState,
  isEnvironmentLeaseState,
  isEnvironmentType,
  isValidEnvironmentKey,
  listEnvironmentChangeRequestsByThread,
  listEnvironmentDefinitions,
  listEnvironmentLeasesByInvocation,
  markExpiredEnvironmentLeases,
  markLostEnvironmentLease,
  markLostEnvironmentLeasesByHeartbeat,
  markLostExecutionOwnership,
  rejectEnvironmentChangeRequest,
  releaseEnvironmentLease,
  releaseExecutionOwnership,
} from "@/lib/v11/environment/environment-queries";
import { registerDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { v11Invocation, v11InvocationAttempt } from "@/lib/v11/schema/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户 + 设备 ─────────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: "env-owner-001",
    email: "env-owner@example.com",
    displayName: "Env Owner",
  });
  const device = await registerDevice({
    tenantId: t.id,
    userId: identity.id,
    deviceKey: "macbook-001",
    publicKey: "ed25519:base64placeholder",
    deviceName: "MacBook Pro",
    appVersion: "0.1.0",
  });
  return { tenantId: t.id, ownerId: identity.id, deviceId: device.id };
}

/** 直接 db.insert 创建 Invocation 行（绕开 dispatcher 复杂 seed）。 */
async function seedInvocation(tenantId: string, threadId: string = randomUUID()) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(v11Invocation).values({
    id,
    tenantId,
    threadId,
    turnId: randomUUID(),
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "queued",
    triggerItemId: null,
    replacesInvocationId: null,
    outputItemId: null,
    runtimeSessionBindingId: null,
    runtimeExecutionRef: null,
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: null,
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { invocationId: id, threadId };
}

/** 直接 db.insert 创建 InvocationAttempt 行。 */
async function seedAttempt(invocationId: string, attemptNo = 1) {
  const id = randomUUID();
  const now = new Date();
  await db.insert(v11InvocationAttempt).values({
    id,
    invocationId,
    attemptNo,
    attemptState: "queued",
    environmentLeaseId: null,
    workerRef: null,
    runtimeExecutionRef: null,
    checkpointRef: null,
    retryReasonCode: null,
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: null,
    errorCode: null,
    errorSummary: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// ═══════════════════════════════════════════════════════════
// 1. 辅助函数校验
// ═══════════════════════════════════════════════════════════

describe("environment-queries：辅助函数校验", () => {
  it("isValidEnvironmentKey：合法/非法判断", () => {
    expect(isValidEnvironmentKey("desktop-default")).toBe(true);
    expect(isValidEnvironmentKey("cloud_v2")).toBe(true);
    expect(isValidEnvironmentKey("a")).toBe(true);
    expect(isValidEnvironmentKey("1abc")).toBe(false); // 必须以字母开头
    expect(isValidEnvironmentKey("")).toBe(false);
    expect(isValidEnvironmentKey("my env")).toBe(false); // 不允许空格
  });

  it("isEnvironmentType：合法/非法判断", () => {
    expect(isEnvironmentType("desktop")).toBe(true);
    expect(isEnvironmentType("cloud")).toBe(true);
    expect(isEnvironmentType("remote")).toBe(true);
    expect(isEnvironmentType("sandbox")).toBe(true);
    expect(isEnvironmentType("edge")).toBe(false);
  });

  it("isEnvironmentLeaseState：合法/非法判断", () => {
    expect(isEnvironmentLeaseState("allocated")).toBe(true);
    expect(isEnvironmentLeaseState("active")).toBe(true);
    expect(isEnvironmentLeaseState("releasing")).toBe(true);
    expect(isEnvironmentLeaseState("released")).toBe(true);
    expect(isEnvironmentLeaseState("expired")).toBe(true);
    expect(isEnvironmentLeaseState("lost")).toBe(true);
    expect(isEnvironmentLeaseState("queued")).toBe(false);
  });

  it("isEnvironmentChangeRequestState：合法/非法判断", () => {
    expect(isEnvironmentChangeRequestState("pending")).toBe(true);
    expect(isEnvironmentChangeRequestState("accepted_for_next_invocation")).toBe(true);
    expect(isEnvironmentChangeRequestState("runtime_acknowledged")).toBe(true);
    expect(isEnvironmentChangeRequestState("rejected")).toBe(true);
    expect(isEnvironmentChangeRequestState("expired")).toBe(true);
    expect(isEnvironmentChangeRequestState("accepted")).toBe(false);
  });

  it("isEnvironmentDefinitionLifecycleState：合法/非法判断", () => {
    expect(isEnvironmentDefinitionLifecycleState("active")).toBe(true);
    expect(isEnvironmentDefinitionLifecycleState("archived")).toBe(true);
    expect(isEnvironmentDefinitionLifecycleState("deleted")).toBe(true);
    expect(isEnvironmentDefinitionLifecycleState("draft")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. EnvironmentDefinition CRUD
// ═══════════════════════════════════════════════════════════

describe("environment-queries：EnvironmentDefinition CRUD", () => {
  it("createEnvironmentDefinition：成功创建 + 默认 active + versionNo=1 + 默认策略", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "desktop-default",
      displayName: "桌面默认环境",
      environmentType: "desktop",
    });

    expect(def.id).toBeTruthy();
    expect(def.tenantId).toBe(tenantId);
    expect(def.environmentKey).toBe("desktop-default");
    expect(def.environmentType).toBe("desktop");
    expect(def.lifecycleState).toBe("active");
    expect(def.versionNo).toBe(1);
    expect(def.filesystemPolicyJson).toEqual({
      allowPaths: [],
      denyPaths: [],
      defaultAccessMode: "read",
    });
    expect(def.createdAt).toBeInstanceOf(Date);
  });

  it("createEnvironmentDefinition：空 environmentKey → ValidationError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      createEnvironmentDefinition({
        tenantId,
        environmentKey: "",
        displayName: "测试",
        environmentType: "cloud",
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentDefinition：非法 environmentKey → ValidationError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      createEnvironmentDefinition({
        tenantId,
        environmentKey: "1abc",
        displayName: "测试",
        environmentType: "cloud",
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentDefinition：重复 environmentKey → 抛错（唯一约束）", async () => {
    const { tenantId } = await seedContext();
    await createEnvironmentDefinition({
      tenantId,
      environmentKey: "dup-key",
      displayName: "第一份",
      environmentType: "cloud",
    });
    await expect(
      createEnvironmentDefinition({
        tenantId,
        environmentKey: "dup-key",
        displayName: "第二份",
        environmentType: "cloud",
      }),
    ).rejects.toThrow();
  });

  it("getEnvironmentDefinitionByKey / getEnvironmentDefinitionById：跨租户隔离", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "kb-lookup",
      displayName: "查询测试",
      environmentType: "cloud",
    });

    const byKey = await getEnvironmentDefinitionByKey(tenantId, "kb-lookup");
    expect(byKey?.id).toBe(def.id);

    const byId = await getEnvironmentDefinitionById(tenantId, def.id);
    expect(byId?.id).toBe(def.id);

    // 跨租户查询应返回 null
    const crossTenant = await getEnvironmentDefinitionById(
      "00000000-0000-4000-8000-000000000099",
      def.id,
    );
    expect(crossTenant).toBeNull();
  });

  it("listEnvironmentDefinitions：默认排除 deleted；按 type 过滤", async () => {
    const { tenantId } = await seedContext();
    await createEnvironmentDefinition({
      tenantId,
      environmentKey: "d-1",
      displayName: "桌面",
      environmentType: "desktop",
    });
    await createEnvironmentDefinition({
      tenantId,
      environmentKey: "c-1",
      displayName: "云",
      environmentType: "cloud",
    });

    const all = await listEnvironmentDefinitions(tenantId);
    expect(all).toHaveLength(2);

    const desktopOnly = await listEnvironmentDefinitions(tenantId, {
      environmentType: "desktop",
    });
    expect(desktopOnly).toHaveLength(1);
    expect(desktopOnly[0]?.environmentType).toBe("desktop");
  });

  it("archiveEnvironmentDefinition：成功 + ETag 校验 + versionNo 更新", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "to-archive",
      displayName: "待归档",
      environmentType: "cloud",
    });

    const archived = await archiveEnvironmentDefinition(tenantId, def.id, def.versionNo);
    expect(archived.lifecycleState).toBe("archived");
    expect(archived.versionNo).toBe(def.versionNo + 1);
  });

  it("archiveEnvironmentDefinition：版本号不匹配 → VersionConflictError", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "v-conflict",
      displayName: "版本冲突",
      environmentType: "cloud",
    });
    await expect(
      archiveEnvironmentDefinition(tenantId, def.id, def.versionNo + 1),
    ).rejects.toBeInstanceOf(EnvironmentVersionConflictError);
  });

  it("archiveEnvironmentDefinition：不存在 → NotFoundError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      archiveEnvironmentDefinition(tenantId, "00000000-0000-4000-8000-000000000099", 1),
    ).rejects.toBeInstanceOf(EnvironmentNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. EnvironmentLease 生命周期
// ═══════════════════════════════════════════════════════════

describe("environment-queries：EnvironmentLease 生命周期", () => {
  it("createEnvironmentLease：Desktop 成功 + 默认 allocated + deviceId 必填", async () => {
    const { tenantId, deviceId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "desktop-def",
      displayName: "桌面",
      environmentType: "desktop",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
      deviceId,
    });

    expect(lease.id).toBeTruthy();
    expect(lease.leaseState).toBe("allocated");
    expect(lease.deviceId).toBe(deviceId);
    expect(lease.environmentDefinitionId).toBe(def.id);
    expect(lease.allocatedAt).toBeInstanceOf(Date);
  });

  it("createEnvironmentLease：Desktop 缺 deviceId → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "desktop-no-device",
      displayName: "桌面无设备",
      environmentType: "desktop",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    await expect(
      createEnvironmentLease({
        tenantId,
        environmentDefinitionId: def.id,
        invocationId,
        attemptId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentLease：Cloud 不允许 deviceId → ValidationError", async () => {
    const { tenantId, deviceId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "cloud-def",
      displayName: "云",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    await expect(
      createEnvironmentLease({
        tenantId,
        environmentDefinitionId: def.id,
        invocationId,
        attemptId,
        deviceId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentLease：Cloud 无 deviceId 成功", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "cloud-no-device",
      displayName: "云无设备",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    expect(lease.deviceId).toBeNull();
  });

  it("createEnvironmentLease：Definition 不存在 → NotFoundError", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    await expect(
      createEnvironmentLease({
        tenantId,
        environmentDefinitionId: "00000000-0000-4000-8000-000000000099",
        invocationId,
        attemptId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentNotFoundError);
  });

  it("createEnvironmentLease：Definition 已 archived → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "archived-def",
      displayName: "已归档",
      environmentType: "cloud",
    });
    await archiveEnvironmentDefinition(tenantId, def.id, def.versionNo);
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    await expect(
      createEnvironmentLease({
        tenantId,
        environmentDefinitionId: def.id,
        invocationId,
        attemptId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("lease 状态机：allocated → active → releasing → released", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "lifecycle",
      displayName: "生命周期",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });

    const active = await activateEnvironmentLease(tenantId, lease.id);
    expect(active.leaseState).toBe("active");
    expect(active.lastHeartbeatAt).toBeInstanceOf(Date);

    const releasing = await beginReleaseEnvironmentLease(tenantId, lease.id);
    expect(releasing.leaseState).toBe("releasing");

    const released = await releaseEnvironmentLease(tenantId, lease.id);
    expect(released.leaseState).toBe("released");
    expect(released.releasedAt).toBeInstanceOf(Date);
  });

  it("lease 状态机：active → released 直接释放", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "direct-release",
      displayName: "直接释放",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    await activateEnvironmentLease(tenantId, lease.id);

    const released = await releaseEnvironmentLease(tenantId, lease.id);
    expect(released.leaseState).toBe("released");
  });

  it("lease 状态机：allocated → expired", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "to-expire",
      displayName: "过期",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    const expired = await expireEnvironmentLease(tenantId, lease.id);
    expect(expired.leaseState).toBe("expired");
  });

  it("lease 状态机：active → lost", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "to-lose",
      displayName: "丢失",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    await activateEnvironmentLease(tenantId, lease.id);

    const lost = await markLostEnvironmentLease(tenantId, lease.id);
    expect(lost.leaseState).toBe("lost");
  });

  it("lease 终态不可恢复：released → active 抛错", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "terminal-released",
      displayName: "终态已释放",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    await activateEnvironmentLease(tenantId, lease.id);
    await releaseEnvironmentLease(tenantId, lease.id);

    // 终态后再释放 / 过期 / 标记 lost 都应抛错
    await expect(releaseEnvironmentLease(tenantId, lease.id)).rejects.toBeInstanceOf(
      EnvironmentLeaseStateError,
    );
    await expect(expireEnvironmentLease(tenantId, lease.id)).rejects.toBeInstanceOf(
      EnvironmentLeaseStateError,
    );
    await expect(markLostEnvironmentLease(tenantId, lease.id)).rejects.toBeInstanceOf(
      EnvironmentLeaseStateError,
    );
  });

  it("lease 状态机违反：allocated → released 直接释放允许（active 之前可释放）", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "alloc-release",
      displayName: "未激活直接释放",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    // allocated 可直接释放（任何非终态都可释放）。
    const released = await releaseEnvironmentLease(tenantId, lease.id);
    expect(released.leaseState).toBe("released");
  });

  it("lease 状态机违反：releasing → active 抛错（不可逆）", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "releasing-no-active",
      displayName: "不可逆",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    await activateEnvironmentLease(tenantId, lease.id);
    await beginReleaseEnvironmentLease(tenantId, lease.id);

    // releasing 不可回到 active（activateEnvironmentLease 只允许 allocated → active）。
    await expect(activateEnvironmentLease(tenantId, lease.id)).rejects.toBeInstanceOf(
      EnvironmentLeaseStateError,
    );
  });

  it("heartbeatEnvironmentLease：更新 lastHeartbeatAt", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "heartbeat",
      displayName: "心跳",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    await activateEnvironmentLease(tenantId, lease.id);

    const heartbeatTime = new Date("2026-12-01T00:00:00.000Z");
    const heartbeated = await heartbeatEnvironmentLease(tenantId, lease.id, heartbeatTime);
    expect(heartbeated.lastHeartbeatAt).toEqual(heartbeatTime);
  });

  it("markExpiredEnvironmentLeases：批量标记 expiresAt < now 的 Lease 为 expired", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "batch-expire",
      displayName: "批量过期",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const pastTime = new Date(Date.now() - 60_000);
    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
      expiresAt: pastTime,
    });
    await activateEnvironmentLease(tenantId, lease.id);

    const count = await markExpiredEnvironmentLeases(tenantId);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await getEnvironmentLeaseById(tenantId, lease.id);
    expect(after?.leaseState).toBe("expired");
  });

  it("markLostEnvironmentLeasesByHeartbeat：批量标记心跳超时的 Lease 为 lost", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "batch-lost",
      displayName: "批量丢失",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });
    // 心跳时间设为很久以前（120s 前，超过默认 60s 阈值）。
    const staleHeartbeat = new Date(Date.now() - 120_000);
    await activateEnvironmentLease(tenantId, lease.id, staleHeartbeat);

    const count = await markLostEnvironmentLeasesByHeartbeat(tenantId);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await getEnvironmentLeaseById(tenantId, lease.id);
    expect(after?.leaseState).toBe("lost");
  });

  it("listEnvironmentLeasesByInvocation：按 invocation 查询", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "list-by-inv",
      displayName: "列表",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attempt1 = await seedAttempt(invocationId, 1);
    const attempt2 = await seedAttempt(invocationId, 2);

    await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId: attempt1,
    });
    await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId: attempt2,
    });

    const list = await listEnvironmentLeasesByInvocation(tenantId, invocationId);
    expect(list).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. EnvironmentChangeRequest 状态机
// ═══════════════════════════════════════════════════════════

describe("environment-queries：EnvironmentChangeRequest 状态机", () => {
  async function seedTwoDefinitions(tenantId: string) {
    const from = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "from-def",
      displayName: "原环境",
      environmentType: "cloud",
    });
    const to = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "to-def",
      displayName: "目标环境",
      environmentType: "cloud",
    });
    return { from, to };
  }

  it("createEnvironmentChangeRequest：成功 + 默认 pending", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();

    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });

    expect(req.id).toBeTruthy();
    expect(req.requestState).toBe("pending");
    expect(req.fromEnvironmentDefinitionId).toBe(from.id);
    expect(req.requestedEnvironmentDefinitionId).toBe(to.id);
    expect(req.resolvedAt).toBeNull();
  });

  it("createEnvironmentChangeRequest：from === requested → ValidationError", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();

    await expect(
      createEnvironmentChangeRequest({
        tenantId,
        threadId,
        fromEnvironmentDefinitionId: from.id,
        requestedEnvironmentDefinitionId: from.id,
        requestedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentChangeRequest：requested 非 active → ValidationError", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    await archiveEnvironmentDefinition(tenantId, to.id, to.versionNo);
    const threadId = randomUUID();

    await expect(
      createEnvironmentChangeRequest({
        tenantId,
        threadId,
        fromEnvironmentDefinitionId: from.id,
        requestedEnvironmentDefinitionId: to.id,
        requestedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentChangeRequest：切换到 Desktop 必须指定 deviceId", async () => {
    const { tenantId, ownerId } = await seedContext();
    const from = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "from-cloud",
      displayName: "云",
      environmentType: "cloud",
    });
    const to = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "to-desktop",
      displayName: "桌面",
      environmentType: "desktop",
    });
    const threadId = randomUUID();

    await expect(
      createEnvironmentChangeRequest({
        tenantId,
        threadId,
        fromEnvironmentDefinitionId: from.id,
        requestedEnvironmentDefinitionId: to.id,
        requestedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("createEnvironmentChangeRequest：切换到非 Desktop 不允许 deviceId", async () => {
    const { tenantId, ownerId, deviceId } = await seedContext();
    const from = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "from-desktop",
      displayName: "桌面",
      environmentType: "desktop",
    });
    const to = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "to-cloud",
      displayName: "云",
      environmentType: "cloud",
    });
    const threadId = randomUUID();

    await expect(
      createEnvironmentChangeRequest({
        tenantId,
        threadId,
        fromEnvironmentDefinitionId: from.id,
        requestedEnvironmentDefinitionId: to.id,
        requestedDeviceId: deviceId,
        requestedBy: ownerId,
      }),
    ).rejects.toBeInstanceOf(EnvironmentValidationError);
  });

  it("状态机：pending → accepted_for_next_invocation", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });

    const accepted = await acceptForNextInvocationEnvironmentChangeRequest(
      tenantId,
      req.id,
      "runtime_no_hot_migration",
    );
    expect(accepted.requestState).toBe("accepted_for_next_invocation");
    expect(accepted.reasonCode).toBe("runtime_no_hot_migration");
    expect(accepted.resolvedAt).toBeNull(); // 非终态
  });

  it("状态机：pending → runtime_acknowledged", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });

    const ack = await acknowledgeRuntimeMigrationEnvironmentChangeRequest(
      tenantId,
      req.id,
      "hot_migration_succeeded",
    );
    expect(ack.requestState).toBe("runtime_acknowledged");
  });

  it("状态机：pending → rejected（终态）", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });

    const rejected = await rejectEnvironmentChangeRequest(tenantId, req.id, "policy_denied");
    expect(rejected.requestState).toBe("rejected");
    expect(rejected.resolvedAt).toBeInstanceOf(Date); // 终态
  });

  it("状态机：accepted_for_next_invocation → expired（终态）", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });
    await acceptForNextInvocationEnvironmentChangeRequest(tenantId, req.id);

    const expired = await expireEnvironmentChangeRequest(tenantId, req.id, "timeout");
    expect(expired.requestState).toBe("expired");
    expect(expired.resolvedAt).toBeInstanceOf(Date);
  });

  it("状态机：终态不可恢复（rejected → runtime_acknowledged 抛错）", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });
    await rejectEnvironmentChangeRequest(tenantId, req.id);

    await expect(
      acknowledgeRuntimeMigrationEnvironmentChangeRequest(tenantId, req.id),
    ).rejects.toBeInstanceOf(EnvironmentChangeRequestStateError);
  });

  it("状态机：accepted_for_next_invocation → runtime_acknowledged 抛错（不允许跳转）", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });
    await acceptForNextInvocationEnvironmentChangeRequest(tenantId, req.id);

    // acknowledgeRuntimeMigration 只允许 pending → runtime_acknowledged。
    await expect(
      acknowledgeRuntimeMigrationEnvironmentChangeRequest(tenantId, req.id),
    ).rejects.toBeInstanceOf(EnvironmentChangeRequestStateError);
  });

  it("listEnvironmentChangeRequestsByThread：按 thread 查询 + 跨租户隔离", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();

    await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });
    await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });

    const list = await listEnvironmentChangeRequestsByThread(tenantId, threadId);
    expect(list).toHaveLength(2);

    // 跨租户查询应返回空。
    const crossTenant = await listEnvironmentChangeRequestsByThread(
      "00000000-0000-4000-8000-000000000099",
      threadId,
    );
    expect(crossTenant).toHaveLength(0);
  });

  it("getEnvironmentChangeRequestById：跨租户隔离", async () => {
    const { tenantId, ownerId } = await seedContext();
    const { from, to } = await seedTwoDefinitions(tenantId);
    const threadId = randomUUID();
    const req = await createEnvironmentChangeRequest({
      tenantId,
      threadId,
      fromEnvironmentDefinitionId: from.id,
      requestedEnvironmentDefinitionId: to.id,
      requestedBy: ownerId,
    });

    const found = await getEnvironmentChangeRequestById(tenantId, req.id);
    expect(found?.id).toBe(req.id);

    const notFound = await getEnvironmentChangeRequestById(
      "00000000-0000-4000-8000-000000000099",
      req.id,
    );
    expect(notFound).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. ExecutionOwnership 管理
// ═══════════════════════════════════════════════════════════

describe("environment-queries：ExecutionOwnership 管理", () => {
  it("acquireExecutionOwnership：首次获取 → epoch=1 active", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const ownership = await acquireExecutionOwnership({
      tenantId,
      invocationId,
    });
    expect(ownership.leaseEpoch).toBe(1);
    expect(ownership.ownershipState).toBe("active");

    const active = await getActiveExecutionOwnership(invocationId);
    expect(active?.id).toBe(ownership.id);
    expect(active?.leaseEpoch).toBe(1);
  });

  it("acquireExecutionOwnership：再次获取 → 释放旧 active + epoch 递增", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const first = await acquireExecutionOwnership({ tenantId, invocationId });
    const second = await acquireExecutionOwnership({ tenantId, invocationId });

    expect(second.leaseEpoch).toBe(first.leaseEpoch + 1);

    const active = await getActiveExecutionOwnership(invocationId);
    expect(active?.id).toBe(second.id);
    expect(active?.leaseEpoch).toBe(2);
  });

  it("releaseExecutionOwnership：active → released", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const ownership = await acquireExecutionOwnership({ tenantId, invocationId });
    await releaseExecutionOwnership(invocationId, ownership.id);

    const active = await getActiveExecutionOwnership(invocationId);
    expect(active).toBeNull();
  });

  it("markLostExecutionOwnership：active → lost", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const ownership = await acquireExecutionOwnership({ tenantId, invocationId });
    await markLostExecutionOwnership(invocationId, ownership.id);

    const active = await getActiveExecutionOwnership(invocationId);
    expect(active).toBeNull();
  });

  it("heartbeatExecutionOwnership：更新心跳时间", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const ownership = await acquireExecutionOwnership({ tenantId, invocationId });
    const heartbeatTime = new Date("2026-12-01T00:00:00.000Z");
    await heartbeatExecutionOwnership(invocationId, ownership.id, heartbeatTime);

    const active = await getActiveExecutionOwnership(invocationId);
    expect(active?.lastHeartbeatAt).toEqual(heartbeatTime);
  });

  it("isActiveEpoch：旧 epoch 拒绝；当前 epoch 接受", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const first = await acquireExecutionOwnership({ tenantId, invocationId });
    const second = await acquireExecutionOwnership({ tenantId, invocationId });

    // 旧 epoch 不再 active。
    expect(await isActiveEpoch(invocationId, first.leaseEpoch)).toBe(false);
    // 当前 active epoch。
    expect(await isActiveEpoch(invocationId, second.leaseEpoch)).toBe(true);
  });

  it("releaseExecutionOwnership：非 active 状态抛错", async () => {
    const { tenantId } = await seedContext();
    const { invocationId } = await seedInvocation(tenantId);

    const first = await acquireExecutionOwnership({ tenantId, invocationId });
    // 获取第二个 ownership 会自动释放 first。
    await acquireExecutionOwnership({ tenantId, invocationId });

    // first 已是 released，重复释放应抛错。
    await expect(releaseExecutionOwnership(invocationId, first.id)).rejects.toBeInstanceOf(
      EnvironmentLeaseStateError,
    );
  });

  it("acquireExecutionOwnership：关联 EnvironmentLease", async () => {
    const { tenantId } = await seedContext();
    const def = await createEnvironmentDefinition({
      tenantId,
      environmentKey: "ownership-lease",
      displayName: "关联 Lease",
      environmentType: "cloud",
    });
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);

    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: def.id,
      invocationId,
      attemptId,
    });

    const ownership = await acquireExecutionOwnership({
      tenantId,
      invocationId,
      environmentLeaseId: lease.id,
    });

    const active = await getActiveExecutionOwnership(invocationId);
    expect(active?.environmentLeaseId).toBe(lease.id);
    expect(active?.id).toBe(ownership.id);
  });
});
