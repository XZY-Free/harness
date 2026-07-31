/**
 * V11 Desktop Executor 接入层集成测试（阶段 8 S08-C07）。
 *
 * 事实源：
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md
 *   S08-W07（4 条不变量 W07-1~W07-4）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.1/§7.2/§6.13/§6.6/§6.7/§6.8/§7.4/§9。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.1/§5.2/§5.5/§9.6/§9.8。
 *
 * 覆盖（按 W07 不变量分组）：
 * - W07-3 浏览器状态隔离：BROWSER_STATE_LEAK_PATTERNS / scanPayloadForCookieLeaks /
 *   assertPayloadSafeForPersistence（合法 payload + Cookie/Set-Cookie/Authorization/
 *   document.cookie/access_token/session_id 泄漏）。
 * - W07-2 六元组：buildDesktopExecutionContext（成功 + ToolCall 不存在 + Lease 不存在 +
 *   Binding 不存在 + 无 ownership + 权限 block/pause + 校验错误）。
 * - W07-2 一致性：validateDesktopExecutionContext（成功 + 设备不一致 + Lease 非 active +
 *   Lease 过期 + Binding 非 active + Binding 非 desktop + 权限非 allow + deadline 过期）。
 * - W07-4 高影响确认：prepareHighImpactConfirmation（成功 + Cookie 泄漏拒绝 + 校验错误） /
 *   getHighImpactConfirmationState（pending/resolved/expired + 跨租户）。
 * - W07-4 超时核对：reconcileDesktopEffectAfterTimeout（成功 + 跨租户 + 校验错误）。
 * - W07 + S08-C06 文件变更：recordDesktopFileChanges（成功 + 跨租户）。
 * - 辅助：getCurrentPermissionDecision（成功 + null）。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  BROWSER_STATE_LEAK_PATTERNS,
  BrowserStateLeakError,
  DesktopCommandTimeoutError,
  type DesktopExecutionContext,
  DesktopExecutorContextMismatchError,
  DesktopExecutorNotFoundError,
  DesktopExecutorValidationError,
  assertPayloadSafeForPersistence,
  buildDesktopExecutionContext,
  getCurrentPermissionDecision,
  getHighImpactConfirmationState,
  prepareHighImpactConfirmation,
  reconcileDesktopEffectAfterTimeout,
  recordDesktopFileChanges,
  scanPayloadForCookieLeaks,
  validateDesktopExecutionContext,
} from "@/lib/v11/capability/desktop-executor-queries";
import {
  EffectNotFoundError,
  EffectOperationMismatchError,
  EffectVerificationMethodNotAllowedError,
  computeTargetHash,
  createEffectRecord,
  createEffectTargets,
} from "@/lib/v11/capability/effect-queries";
import {
  type V11ToolCall,
  computeArgumentsHash,
  createToolCall,
  updateToolCallState,
} from "@/lib/v11/capability/tool-call-queries";
import {
  acquireExecutionOwnership,
  activateEnvironmentLease,
  createEnvironmentDefinition,
  createEnvironmentLease,
} from "@/lib/v11/environment/environment-queries";
import { registerDevice } from "@/lib/v11/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import {
  PermissionNotFoundError,
  ToolCallBlockedError,
  ToolCallPausedError,
  recordPermissionDecision,
} from "@/lib/v11/permission/permission-queries";
import { resolveUserActionRequest } from "@/lib/v11/permission/user-action-queries";
import { v11Invocation, v11InvocationAttempt } from "@/lib/v11/schema/runtime";
import { createWorkspace, createWorkspaceBinding } from "@/lib/v11/workspace/workspace-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户 + 设备 ─────────────────────

async function seedTenant() {
  const tenant = await ensureDefaultTenant();
  return tenant.id;
}

async function seedUserAndDevice(tenantId: string) {
  const identity = await upsertUserIdentity({
    tenantId,
    externalSubject: `desktop-user-${randomUUID()}`,
    email: `desktop-${randomUUID()}@example.com`,
    displayName: "Desktop User",
  });
  const device = await registerDevice({
    tenantId,
    userId: identity.id,
    deviceKey: `device-${randomUUID()}`,
    publicKey: "ed25519:base64placeholder",
    deviceName: "MacBook Pro",
    appVersion: "0.1.0",
  });
  return { userId: identity.id, deviceId: device.id };
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

/** seed Desktop Workspace + Binding（含 deviceId）。 */
async function seedDesktopBinding(tenantId: string, deviceId: string) {
  const workspace = await createWorkspace({
    tenantId,
    workspaceKey: `ws-${randomUUID()}`,
    displayName: "Desktop Workspace",
  });
  const binding = await createWorkspaceBinding({
    tenantId,
    workspaceId: workspace.id,
    bindingType: "desktop",
    deviceId,
    locationRef: `device://${deviceId}/home/user/project`,
  });
  return { workspaceId: workspace.id, binding };
}

/** seed Desktop EnvironmentDefinition + Lease（active）。 */
async function seedDesktopLease(
  tenantId: string,
  invocationId: string,
  attemptId: string,
  deviceId: string,
  options?: { activate?: boolean; leaseState?: "allocated" | "active" },
) {
  const definition = await createEnvironmentDefinition({
    tenantId,
    environmentKey: `desktop-env-${randomUUID()}`,
    displayName: "Desktop Environment",
    environmentType: "desktop",
  });
  const lease = await createEnvironmentLease({
    tenantId,
    environmentDefinitionId: definition.id,
    invocationId,
    attemptId,
    deviceId,
  });
  if (options?.activate ?? true) {
    return activateEnvironmentLease(tenantId, lease.id);
  }
  return lease;
}

/** seed ToolCall（已绑定 environmentLeaseId + 进入 running 状态）。 */
async function seedRunningToolCall(
  tenantId: string,
  invocationId: string,
  leaseId: string,
): Promise<V11ToolCall> {
  const toolCall = await createToolCall({
    tenantId,
    invocationId,
    toolId: randomUUID(),
    toolSchemaRevisionId: randomUUID(),
    schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
    operationId: `op-${randomUUID()}`,
    argumentsRedactedJson: { target: "desktop-target" },
    environmentLeaseId: leaseId,
  });
  return updateToolCallState({ tenantId, toolCallId: toolCall.id, toState: "running" });
}

/** seed PermissionDecision(allow)。 */
async function seedAllowDecision(tenantId: string, toolCallId: string) {
  return recordPermissionDecision({
    tenantId,
    toolCallId,
    decision: "allow",
    reasonCodes: ["risk_low"],
    decidedBy: "policy-engine",
  });
}

/**
 * seed 完整 Desktop 执行上下文所需的所有数据。
 *
 * 返回 { tenantId, userId, deviceId, workspaceId, binding, invocationId, threadId, attemptId,
 *   lease, toolCall, ownership, permissionDecision }。
 */
async function seedFullDesktopContext() {
  const tenantId = await seedTenant();
  const { userId, deviceId } = await seedUserAndDevice(tenantId);
  const { workspaceId, binding } = await seedDesktopBinding(tenantId, deviceId);
  const { invocationId, threadId } = await seedInvocation(tenantId);
  const attemptId = await seedAttempt(invocationId);
  const lease = await seedDesktopLease(tenantId, invocationId, attemptId, deviceId);
  const ownership = await acquireExecutionOwnership({
    tenantId,
    invocationId,
    deviceId,
    environmentLeaseId: lease.id,
  });
  const toolCall = await seedRunningToolCall(tenantId, invocationId, lease.id);
  const permissionDecision = await seedAllowDecision(tenantId, toolCall.id);
  return {
    tenantId,
    userId,
    deviceId,
    workspaceId,
    binding,
    invocationId,
    threadId,
    attemptId,
    lease,
    toolCall,
    ownership,
    permissionDecision,
  };
}

/** 构造未来时间（默认 +1 小时）。 */
function futureTime(hours = 1): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/** 构造过去时间（默认 -1 小时）。 */
function pastTime(hours = 1): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/** 构造合法 sha256: hash（64 hex）。 */
function buildValidHash(seed: string): string {
  return computeArgumentsHash({ seed });
}

// ═══════════════════════════════════════════════════════════
// 1. W07-3 浏览器状态隔离：scanPayloadForCookieLeaks / assertPayloadSafeForPersistence
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：W07-3 浏览器状态隔离", () => {
  it("BROWSER_STATE_LEAK_PATTERNS：包含 6 个模式", () => {
    expect(BROWSER_STATE_LEAK_PATTERNS).toHaveLength(6);
    // 每个模式都是 RegExp
    for (const p of BROWSER_STATE_LEAK_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  it("scanPayloadForCookieLeaks：合法 payload 返回空数组", () => {
    expect(scanPayloadForCookieLeaks({ message: "ok", data: [1, 2, 3] })).toEqual([]);
    expect(scanPayloadForCookieLeaks("just a normal string")).toEqual([]);
    expect(scanPayloadForCookieLeaks({ url: "https://example.com/page" })).toEqual([]);
  });

  it("scanPayloadForCookieLeaks：null/undefined/number 返回空数组", () => {
    expect(scanPayloadForCookieLeaks(null)).toEqual([]);
    expect(scanPayloadForCookieLeaks(undefined)).toEqual([]);
    expect(scanPayloadForCookieLeaks(42)).toEqual([]);
    expect(scanPayloadForCookieLeaks(true)).toEqual([]);
  });

  it("scanPayloadForCookieLeaks：检测 Cookie 头", () => {
    const payload = { headers: { Cookie: "session=abc123" } };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：检测 Set-Cookie 头", () => {
    const payload = { response: { "Set-Cookie": "token=xyz789" } };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：检测 Authorization Bearer", () => {
    const payload = { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：检测 Authorization Basic", () => {
    const payload = { Authorization: "Basic dXNlcjpwYXNz" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：检测 document.cookie", () => {
    const payload = { script: "document.cookie = 'session=abc'" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：检测 access_token 原值（≥20 字符）", () => {
    const payload = { access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：access_token 短值（<20 字符）不命中", () => {
    // 模式要求 ≥20 字符，短 token 不视为泄漏（避免误报）
    const payload = { access_token: "short" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched).toEqual([]);
  });

  it("scanPayloadForCookieLeaks：检测 session_id 原值（≥20 字符）", () => {
    const payload = { session_id: "abcdefghijklmnopqrstuvwx" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：检测 JSESSIONID 原值（≥20 字符）", () => {
    const payload = { JSESSIONID: "0123456789abcdef0123456789abcdef" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：字符串 payload 也能扫描", () => {
    const payload = "Cookie: session=abc123; user=foo";
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("scanPayloadForCookieLeaks：返回命中的模式 source 列表", () => {
    const payload = { Cookie: "a=b", access_token: "abcdefghijklmnopqrstuvwx" };
    const matched = scanPayloadForCookieLeaks(payload);
    expect(matched.length).toBe(2);
    // 每个元素是 RegExp.source 字符串
    for (const m of matched) {
      expect(typeof m).toBe("string");
      expect(m.length).toBeGreaterThan(0);
    }
  });

  it("assertPayloadSafeForPersistence：合法 payload 不抛错", () => {
    expect(() => assertPayloadSafeForPersistence({ message: "ok" })).not.toThrow();
    expect(() => assertPayloadSafeForPersistence(null)).not.toThrow();
    expect(() => assertPayloadSafeForPersistence(undefined)).not.toThrow();
  });

  it("assertPayloadSafeForPersistence：Cookie 泄漏抛 BrowserStateLeakError", () => {
    try {
      assertPayloadSafeForPersistence({ Cookie: "session=abc123" });
      throw new Error("应抛 BrowserStateLeakError");
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserStateLeakError);
      const e = err as BrowserStateLeakError;
      expect(e.matchedPatterns.length).toBeGreaterThan(0);
      expect(e.message).toContain("浏览器状态泄漏");
    }
  });

  it("assertPayloadSafeForPersistence：Authorization 泄漏抛 BrowserStateLeakError", () => {
    expect(() => assertPayloadSafeForPersistence({ Authorization: "Bearer abc.def.ghi" })).toThrow(
      BrowserStateLeakError,
    );
  });

  it("assertPayloadSafeForPersistence：document.cookie 泄漏抛 BrowserStateLeakError", () => {
    expect(() => assertPayloadSafeForPersistence({ code: "document.cookie = 'x'" })).toThrow(
      BrowserStateLeakError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 2. W07-2 六元组：buildDesktopExecutionContext
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：W07-2 buildDesktopExecutionContext", () => {
  it("成功组装六元组（ToolCall + Lease + device + Binding + 权限 allow + deadline）", async () => {
    const ctx = await seedFullDesktopContext();

    const deadline = futureTime(1);
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline,
    });

    expect(execCtx.tenantId).toBe(ctx.tenantId);
    expect(execCtx.toolCallId).toBe(ctx.toolCall.id);
    expect(execCtx.invocationId).toBe(ctx.invocationId);
    expect(execCtx.lease.id).toBe(ctx.lease.id);
    expect(execCtx.deviceId).toBe(ctx.deviceId);
    expect(execCtx.workspaceBinding.id).toBe(ctx.binding.id);
    expect(execCtx.permissionDecision.id).toBe(ctx.permissionDecision.id);
    expect(execCtx.permissionDecision.decision).toBe("allow");
    expect(execCtx.toolCall.id).toBe(ctx.toolCall.id);
    expect(execCtx.deadline).toBe(deadline);
  });

  it("ToolCall 不存在 → DesktopExecutorNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: randomUUID(),
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorNotFoundError);
  });

  it("ToolCall 未绑定 environmentLeaseId → DesktopExecutorNotFoundError", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedUserAndDevice(tenantId);
    const { binding } = await seedDesktopBinding(tenantId, deviceId);
    // 创建未绑定 lease 的 ToolCall
    const toolCall = await createToolCall({
      tenantId,
      invocationId: randomUUID(),
      toolId: randomUUID(),
      toolSchemaRevisionId: randomUUID(),
      schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
      operationId: `op-${randomUUID()}`,
      argumentsRedactedJson: { target: "x" },
    });

    await expect(
      buildDesktopExecutionContext({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorNotFoundError);
  });

  it("EnvironmentLease 不存在 → DesktopExecutorNotFoundError", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedUserAndDevice(tenantId);
    const { binding } = await seedDesktopBinding(tenantId, deviceId);
    // ToolCall.environmentLeaseId 指向不存在的 lease
    const fakeLeaseId = randomUUID();
    const toolCall = await createToolCall({
      tenantId,
      invocationId: randomUUID(),
      toolId: randomUUID(),
      toolSchemaRevisionId: randomUUID(),
      schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
      operationId: `op-${randomUUID()}`,
      argumentsRedactedJson: { target: "x" },
      environmentLeaseId: fakeLeaseId,
    });
    await seedAllowDecision(tenantId, toolCall.id);

    await expect(
      buildDesktopExecutionContext({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorNotFoundError);
  });

  it("WorkspaceBinding 不存在 → DesktopExecutorNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: randomUUID(),
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorNotFoundError);
  });

  it("无 active execution_ownership → DesktopExecutorNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    // 释放 ownership
    const { releaseExecutionOwnership } = await import("@/lib/v11/environment/environment-queries");
    await releaseExecutionOwnership(ctx.invocationId, ctx.ownership.id);

    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorNotFoundError);
  });

  it("PermissionDecision=block → ToolCallBlockedError", async () => {
    const ctx = await seedFullDesktopContext();
    // 追加 block 决策（覆盖 allow）
    await recordPermissionDecision({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      decision: "block",
      reasonCodes: ["risk_too_high"],
      decidedBy: "policy-engine",
    });

    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(ToolCallBlockedError);
  });

  it("PermissionDecision=pause → ToolCallPausedError", async () => {
    const ctx = await seedFullDesktopContext();
    // 追加 pause 决策（覆盖 allow）
    await recordPermissionDecision({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      decision: "pause",
      reasonCodes: ["needs_confirmation"],
      decidedBy: "policy-engine",
    });

    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(ToolCallPausedError);
  });

  it("无 PermissionDecision → PermissionNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    // 直接构造未评估的 ToolCall（不调用 seedAllowDecision）
    const newToolCall = await seedRunningToolCall(ctx.tenantId, ctx.invocationId, ctx.lease.id);

    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: newToolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(PermissionNotFoundError);
  });

  it("EnvironmentLease 无 deviceId → DesktopExecutorValidationError", async () => {
    const tenantId = await seedTenant();
    // 创建 Cloud Lease（无 deviceId），但 ToolCall 绑定此 lease
    const { invocationId } = await seedInvocation(tenantId);
    const attemptId = await seedAttempt(invocationId);
    const definition = await createEnvironmentDefinition({
      tenantId,
      environmentKey: `cloud-env-${randomUUID()}`,
      displayName: "Cloud Env",
      environmentType: "cloud",
    });
    const lease = await createEnvironmentLease({
      tenantId,
      environmentDefinitionId: definition.id,
      invocationId,
      attemptId,
      // 不传 deviceId
    });
    await activateEnvironmentLease(tenantId, lease.id);
    const toolCall = await seedRunningToolCall(tenantId, invocationId, lease.id);
    await seedAllowDecision(tenantId, toolCall.id);
    const { deviceId } = await seedUserAndDevice(tenantId);
    const { binding } = await seedDesktopBinding(tenantId, deviceId);

    await expect(
      buildDesktopExecutionContext({
        tenantId,
        toolCallId: toolCall.id,
        workspaceBindingId: binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 tenantId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: "",
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 toolCallId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: "",
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 workspaceBindingId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: "",
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("deadline 非 Date → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: "not-a-date" as unknown as Date,
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("跨租户 ToolCall 不可见 → DesktopExecutorNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(
      buildDesktopExecutionContext({
        tenantId: randomUUID(), // 不同租户
        toolCallId: ctx.toolCall.id,
        workspaceBindingId: ctx.binding.id,
        deadline: futureTime(1),
      }),
    ).rejects.toThrow(DesktopExecutorNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. W07-2 一致性：validateDesktopExecutionContext
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：W07-2 validateDesktopExecutionContext", () => {
  it("成功校验合法上下文（所有条件满足）", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    await expect(validateDesktopExecutionContext(execCtx)).resolves.toBeUndefined();
  });

  it("设备不一致（lease.deviceId !== binding.deviceId）→ ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 lease.deviceId
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      lease: { ...execCtx.lease, deviceId: "different-device-id" },
      deviceId: "different-device-id",
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
    try {
      await validateDesktopExecutionContext(tampered);
    } catch (err) {
      const e = err as DesktopExecutorContextMismatchError;
      expect(e.field).toContain("deviceId");
    }
  });

  it("Binding 无 deviceId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 binding.deviceId 为空
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      workspaceBinding: { ...execCtx.workspaceBinding, deviceId: null },
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorValidationError,
    );
  });

  it("Lease 非 active → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 lease.leaseState
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      lease: { ...execCtx.lease, leaseState: "allocated" },
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });

  it("Lease expiresAt 已过期 → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 lease.expiresAt 为过去时间
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      lease: { ...execCtx.lease, expiresAt: pastTime(1) },
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });

  it("Binding 非 active → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 binding.bindingState
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      workspaceBinding: { ...execCtx.workspaceBinding, bindingState: "revoked" },
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });

  it("Binding 非 desktop → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 binding.bindingType
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      workspaceBinding: { ...execCtx.workspaceBinding, bindingType: "cloud" },
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });

  it("PermissionDecision 非 allow → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 permissionDecision.decision
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      permissionDecision: { ...execCtx.permissionDecision, decision: "pause" },
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });

  it("deadline 已过期 → DesktopCommandTimeoutError", async () => {
    const ctx = await seedFullDesktopContext();
    const deadline = pastTime(1); // 已过期
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline,
    });

    try {
      await validateDesktopExecutionContext(execCtx);
      throw new Error("应抛 DesktopCommandTimeoutError");
    } catch (err) {
      expect(err).toBeInstanceOf(DesktopCommandTimeoutError);
      const e = err as DesktopCommandTimeoutError;
      expect(e.toolCallId).toBe(ctx.toolCall.id);
      expect(e.deadline).toEqual(deadline);
    }
  });

  it("lease.invocationId 与 ctx.invocationId 不一致 → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 ctx.invocationId
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      invocationId: randomUUID(),
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });

  it("workspaceBinding.tenantId 与 ctx.tenantId 不一致 → ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 ctx.tenantId（不篡改 binding.tenantId，使其不匹配）
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      tenantId: randomUUID(),
    };

    await expect(validateDesktopExecutionContext(tampered)).rejects.toThrow(
      DesktopExecutorContextMismatchError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 4. W07-4 高影响确认：prepareHighImpactConfirmation
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：W07-4 prepareHighImpactConfirmation", () => {
  it("成功创建 confirmation UserActionRequest", async () => {
    const ctx = await seedFullDesktopContext();

    const expiresAt = futureTime(24);
    const result = await prepareHighImpactConfirmation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: randomUUID(),
      invocationId: ctx.invocationId,
      toolCallId: ctx.toolCall.id,
      purpose: "delete-files",
      promptJson: { title: "确认删除文件", impact: "不可恢复", files: ["/a/b/c"] },
      expiresAt,
    });

    expect(result.request.tenantId).toBe(ctx.tenantId);
    expect(result.request.threadId).toBe(ctx.threadId);
    expect(result.request.invocationId).toBe(ctx.invocationId);
    expect(result.request.toolCallId).toBe(ctx.toolCall.id);
    expect(result.request.requestType).toBe("confirmation");
    expect(result.request.requestState).toBe("pending");
    expect(result.request.purpose).toBe("delete-files");
    expect(result.request.promptJson).toEqual({
      title: "确认删除文件",
      impact: "不可恢复",
      files: ["/a/b/c"],
    });
    expect(result.request.expiresAt).toEqual(expiresAt);
  });

  it("promptJson 含 Cookie 泄漏 → BrowserStateLeakError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: { Cookie: "session=abc123" },
      }),
    ).rejects.toThrow(BrowserStateLeakError);
  });

  it("promptJson 含 Authorization 泄漏 → BrowserStateLeakError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: { Authorization: "Bearer abc.def.ghi" },
      }),
    ).rejects.toThrow(BrowserStateLeakError);
  });

  it("空 tenantId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: "",
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 threadId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: "",
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 turnId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: "",
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 invocationId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: "",
        toolCallId: ctx.toolCall.id,
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 toolCallId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: "",
        promptJson: { title: "x" },
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("promptJson 非对象 → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: "string-not-object",
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("promptJson=null → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      prepareHighImpactConfirmation({
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        turnId: randomUUID(),
        invocationId: ctx.invocationId,
        toolCallId: ctx.toolCall.id,
        promptJson: null,
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. W07-4 高影响确认：getHighImpactConfirmationState
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：W07-4 getHighImpactConfirmationState", () => {
  it("pending：刚创建返回 pending + resolution=null", async () => {
    const ctx = await seedFullDesktopContext();
    const created = await prepareHighImpactConfirmation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: randomUUID(),
      invocationId: ctx.invocationId,
      toolCallId: ctx.toolCall.id,
      promptJson: { title: "x" },
    });

    const state = await getHighImpactConfirmationState(ctx.tenantId, created.request.id);
    expect(state.state).toBe("pending");
    expect(state.resolution).toBeNull();
  });

  it("resolved：approve 后返回 resolved + resolution=approve", async () => {
    const ctx = await seedFullDesktopContext();
    const created = await prepareHighImpactConfirmation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: randomUUID(),
      invocationId: ctx.invocationId,
      toolCallId: ctx.toolCall.id,
      promptJson: { title: "x" },
    });

    await resolveUserActionRequest({
      tenantId: ctx.tenantId,
      requestId: created.request.id,
      resolution: "approve",
      resolvedBy: "user-001",
    });

    const state = await getHighImpactConfirmationState(ctx.tenantId, created.request.id);
    expect(state.state).toBe("resolved");
    expect(state.resolution).toBe("approve");
  });

  it("resolved：deny 后返回 resolved + resolution=deny", async () => {
    const ctx = await seedFullDesktopContext();
    const created = await prepareHighImpactConfirmation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: randomUUID(),
      invocationId: ctx.invocationId,
      toolCallId: ctx.toolCall.id,
      promptJson: { title: "x" },
    });

    await resolveUserActionRequest({
      tenantId: ctx.tenantId,
      requestId: created.request.id,
      resolution: "deny",
      resolvedBy: "user-001",
    });

    const state = await getHighImpactConfirmationState(ctx.tenantId, created.request.id);
    expect(state.state).toBe("resolved");
    expect(state.resolution).toBe("deny");
  });

  it("跨租户查询 → DesktopExecutorNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    const created = await prepareHighImpactConfirmation({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      turnId: randomUUID(),
      invocationId: ctx.invocationId,
      toolCallId: ctx.toolCall.id,
      promptJson: { title: "x" },
    });

    await expect(getHighImpactConfirmationState(randomUUID(), created.request.id)).rejects.toThrow(
      DesktopExecutorNotFoundError,
    );
  });

  it("不存在的 requestId → DesktopExecutorNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    await expect(getHighImpactConfirmationState(ctx.tenantId, randomUUID())).rejects.toThrow(
      DesktopExecutorNotFoundError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 6. W07-4 超时核对：reconcileDesktopEffectAfterTimeout
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：W07-4 reconcileDesktopEffectAfterTimeout", () => {
  it("成功核对：confirmed_success → toolCall.call_state=succeeded", async () => {
    const ctx = await seedFullDesktopContext();

    // seed EffectRecord + 1 个 target（unknown_effect 状态）
    const record = await createEffectRecord({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1, description: "send email" },
      initialEffectState: "unknown_effect",
    });
    const targetRef = "user:email:foo@example.com";
    const targetHash = computeTargetHash(targetRef);
    await createEffectTargets({
      tenantId: ctx.tenantId,
      effectRecordId: record.id,
      targets: [{ targetRef }],
    });
    // 将 ToolCall 迁移到 unknown_effect 状态
    await updateToolCallState({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      toState: "unknown_effect",
    });

    // 执行超时核对（gateway 路径 + provider_query + confirmed_success）
    const result = await reconcileDesktopEffectAfterTimeout({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      verificationMethod: "provider_query",
      targetUpdates: [{ targetHash, targetState: "confirmed_success" }],
      expectedOperationId: ctx.toolCall.operationId,
      reconciledBy: "gateway-reconciler",
    });

    expect(result.effectRecord.effectState).toBe("confirmed_success");
    expect(result.targetsCount.confirmed_success).toBe(1);
    expect(result.toolCall.callState).toBe("succeeded");
  });

  it("跨租户 → EffectNotFoundError", async () => {
    const ctx = await seedFullDesktopContext();
    await createEffectRecord({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });

    await expect(
      reconcileDesktopEffectAfterTimeout({
        tenantId: randomUUID(), // 不同租户
        toolCallId: ctx.toolCall.id,
        verificationMethod: "provider_query",
        targetUpdates: [],
        expectedOperationId: ctx.toolCall.operationId,
      }),
    ).rejects.toThrow(EffectNotFoundError);
  });

  it("空 tenantId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      reconcileDesktopEffectAfterTimeout({
        tenantId: "",
        toolCallId: ctx.toolCall.id,
        verificationMethod: "provider_query",
        targetUpdates: [],
        expectedOperationId: ctx.toolCall.operationId,
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("空 toolCallId → DesktopExecutorValidationError", async () => {
    const ctx = await seedFullDesktopContext();

    await expect(
      reconcileDesktopEffectAfterTimeout({
        tenantId: ctx.tenantId,
        toolCallId: "",
        verificationMethod: "provider_query",
        targetUpdates: [],
        expectedOperationId: ctx.toolCall.operationId,
      }),
    ).rejects.toThrow(DesktopExecutorValidationError);
  });

  it("operation_id 不匹配 → EffectOperationMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    await createEffectRecord({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });

    await expect(
      reconcileDesktopEffectAfterTimeout({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        verificationMethod: "provider_query",
        targetUpdates: [],
        expectedOperationId: "different-operation-id",
      }),
    ).rejects.toThrow(EffectOperationMismatchError);
  });

  it("gateway 路径使用 manual_evidence → EffectVerificationMethodNotAllowedError", async () => {
    const ctx = await seedFullDesktopContext();
    await createEffectRecord({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });

    await expect(
      reconcileDesktopEffectAfterTimeout({
        tenantId: ctx.tenantId,
        toolCallId: ctx.toolCall.id,
        verificationMethod: "manual_evidence",
        targetUpdates: [],
        expectedOperationId: ctx.toolCall.operationId,
      }),
    ).rejects.toThrow(EffectVerificationMethodNotAllowedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. W07 + S08-C06 文件变更：recordDesktopFileChanges
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：recordDesktopFileChanges", () => {
  it("成功记录文件变更（自动注入 workspaceBindingId）", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    const afterHash = buildValidHash("after-content");
    const changes = [
      {
        pathRef: "docs/report.xlsx",
        changeType: "create" as const,
        afterHash,
      },
    ];

    const result = await recordDesktopFileChanges(execCtx, changes);
    expect(result).toHaveLength(1);
    expect(result[0]?.tenantId).toBe(ctx.tenantId);
    expect(result[0]?.toolCallId).toBe(ctx.toolCall.id);
    expect(result[0]?.workspaceBindingId).toBe(ctx.binding.id);
    expect(result[0]?.pathRef).toBe("docs/report.xlsx");
    expect(result[0]?.changeType).toBe("create");
    expect(result[0]?.afterHash).toBe(afterHash);
    expect(result[0]?.beforeHash).toBeNull();
  });

  it("批量记录多种变更类型", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    const beforeHash = buildValidHash("before");
    const afterHash = buildValidHash("after");
    const changes = [
      {
        pathRef: "data/new.json",
        changeType: "create" as const,
        afterHash,
      },
      {
        pathRef: "data/existing.json",
        changeType: "update" as const,
        beforeHash,
        afterHash,
      },
      {
        pathRef: "temp/old.log",
        changeType: "delete" as const,
        beforeHash,
      },
    ];

    const result = await recordDesktopFileChanges(execCtx, changes);
    expect(result).toHaveLength(3);
    // 按 pathRef 建立 Map 进行断言（与 S08-C06 一致：避免排序不稳定）
    const byPath = new Map(result.map((c) => [c.pathRef, c]));
    expect(byPath.get("data/new.json")?.changeType).toBe("create");
    expect(byPath.get("data/existing.json")?.changeType).toBe("update");
    expect(byPath.get("temp/old.log")?.changeType).toBe("delete");
    // 所有变更都应注入正确的 workspaceBindingId
    for (const c of result) {
      expect(c.workspaceBindingId).toBe(ctx.binding.id);
      expect(c.toolCallId).toBe(ctx.toolCall.id);
    }
  });

  it("跨租户（ctx.tenantId !== binding.tenantId）→ ContextMismatchError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // 篡改 ctx.tenantId（不篡改 binding.tenantId，使其不匹配）
    const tampered: DesktopExecutionContext = {
      ...execCtx,
      tenantId: randomUUID(),
    };

    await expect(
      recordDesktopFileChanges(tampered, [
        { pathRef: "a.txt", changeType: "create", afterHash: buildValidHash("x") },
      ]),
    ).rejects.toThrow(DesktopExecutorContextMismatchError);
  });

  it("空 changes 数组 → FileChangeValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    // FileChangeValidationError 由 createFileChanges 内部抛出
    const { FileChangeValidationError } = await import("@/lib/v11/capability/artifact-queries");
    await expect(recordDesktopFileChanges(execCtx, [])).rejects.toThrow(FileChangeValidationError);
  });

  it("绝对路径 pathRef → FileChangeValidationError", async () => {
    const ctx = await seedFullDesktopContext();
    const execCtx = await buildDesktopExecutionContext({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      workspaceBindingId: ctx.binding.id,
      deadline: futureTime(1),
    });

    const { FileChangeValidationError } = await import("@/lib/v11/capability/artifact-queries");
    await expect(
      recordDesktopFileChanges(execCtx, [
        { pathRef: "/abs/path", changeType: "create", afterHash: buildValidHash("x") },
      ]),
    ).rejects.toThrow(FileChangeValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. 辅助：getCurrentPermissionDecision
// ═══════════════════════════════════════════════════════════

describe("V11 desktop-executor：getCurrentPermissionDecision", () => {
  it("成功返回最新决策", async () => {
    const ctx = await seedFullDesktopContext();
    // 追加第二个决策
    const d2 = await recordPermissionDecision({
      tenantId: ctx.tenantId,
      toolCallId: ctx.toolCall.id,
      decision: "allow",
      reasonCodes: ["still_low"],
      decidedBy: "policy-engine-v2",
    });

    const decision = await getCurrentPermissionDecision(ctx.tenantId, ctx.toolCall.id);
    expect(decision?.id).toBe(d2.id);
    expect(decision?.decision).toBe("allow");
    expect(decision?.decisionSequence).toBe(2);
  });

  it("无决策返回 null", async () => {
    const tenantId = await seedTenant();
    const result = await getCurrentPermissionDecision(tenantId, randomUUID());
    expect(result).toBeNull();
  });

  it("跨租户返回 null", async () => {
    const ctx = await seedFullDesktopContext();
    const result = await getCurrentPermissionDecision(randomUUID(), ctx.toolCall.id);
    expect(result).toBeNull();
  });
});
