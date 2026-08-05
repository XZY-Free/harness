/**
 * S09-C03：V11 主 Agent Handoff 应用服务集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - requestHandoff：成功 + UserActionRequest + user_action ThreadItem + 3 条 Event +
 *   Invocation 转 waiting_user；错误路径（同 Agent / 目标 Agent 禁用 / Thread 不存在 /
 *   Invocation 非 running）
 * - resolveHandoff approve：UserActionRequest resolved + Thread.primary_agent_id 变更 +
 *   3 条 Event（user_action.resolved + thread.primary_agent_changed + handoff.completed）+
 *   resume InvocationCommand
 * - resolveHandoff deny：UserActionRequest resolved + 主 Agent 不变 + 1 条 Event +
 *   resume InvocationCommand
 * - 幂等：重复 resolve 抛 HandoffAlreadyResolvedError
 * - purpose 不匹配：非 handoff 请求抛 HandoffValidationError
 * - 查询：getPendingHandoffRequest / listHandoffRequests
 *
 * 不变量（事实源：05 文档 §12 行 250-260；12 文档 §5 行 296-305）：
 * - Workflow/Runtime 必须先创建 UserActionRequest，不能直接调用 change-primary-agent
 * - 员工确认后才修改 Thread.primary_agent_id
 * - 拒绝时主 Agent、Workspace、Memory、Tool 权限保持不变
 * - Handoff 不创建 ThreadRelation，不创建新 Thread
 * - Child Thread 完成不等同于接管主责
 */
import { randomUUID } from "node:crypto";
import { createAgent, updateAgentLifecycle } from "@/lib/agents/persistence/agent-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  HandoffAlreadyResolvedError,
  HandoffValidationError,
  ThreadNotFoundError,
} from "@/lib/v11/conversation/errors";
import {
  HANDOFF_PURPOSE,
  getPendingHandoffRequest,
  listHandoffRequests,
  requestHandoff,
  resolveHandoff,
} from "@/lib/v11/conversation/handoff-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { createInvocation, updateInvocationState } from "@/lib/v11/runtime/invocation-queries";
import { v11Thread, v11ThreadItem } from "@/lib/v11/schema/conversation";
import { v11UserActionRequest } from "@/lib/v11/schema/user-action-request";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 + 双 Agent + Thread + running Invocation ───

async function seedHandoffFixture() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "owner-001",
    email: "owner001@example.com",
    displayName: "Thread Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "owner-001",
    displayName: "Thread Owner",
    userIdentityId: identity.id,
  });

  // 主 Agent（parent）
  const primaryAgent = await createAgent({
    tenantId: tenant.id,
    agentKey: "primary-agent",
    displayName: "Primary Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });

  // 目标 Agent（target，handoff 后将接管）
  const targetAgent = await createAgent({
    tenantId: tenant.id,
    agentKey: "target-agent",
    displayName: "Target Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });

  // 创建 Thread + 接纳用户消息 Turn + 创建 Invocation + 转 running
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: identity.id,
    primaryAgentId: primaryAgent.id,
    actorId: identity.id,
  });
  const { turn } = await acceptUserMessageTurn({
    tenantId: tenant.id,
    threadId: thread.id,
    ownerUserId: identity.id,
    content: { text: "测试 handoff" } as unknown as Parameters<
      typeof acceptUserMessageTurn
    >[0]["content"],
    actorId: identity.id,
  });
  const { invocation } = await createInvocation({
    tenantId: tenant.id,
    threadId: thread.id,
    turnId: turn.id,
    invocationKind: "initial",
    triggerItemId: turn.triggerItemId,
    actorType: "system",
  });
  let runningInvocation = invocation;
  await db.transaction(async (tx) => {
    runningInvocation = await updateInvocationState(tx, tenant.id, invocation.id, "running");
  });

  return {
    tenantId: tenant.id,
    ownerId: identity.id,
    primaryAgentId: primaryAgent.id,
    targetAgentId: targetAgent.id,
    threadId: thread.id,
    turnId: turn.id,
    invocationId: runningInvocation.id,
    primaryAgent,
    targetAgent,
  };
}

// ─── requestHandoff 成功路径 ─────────────────────────────

describe("requestHandoff 成功路径", () => {
  it("成功创建 handoff 请求 + UserActionRequest + ThreadItem + 3 条 Event + Invocation 转 waiting_user", async () => {
    const fx = await seedHandoffFixture();

    const result = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "切换为风险审核 Agent",
      impact: "主 Agent 将从 Primary Agent 改为 Target Agent",
      actorType: "system",
      actorId: "workflow-runtime-1",
      idempotencyKey: "handoff-req-001",
      correlationId: "corr-001",
    });

    // UserActionRequest 校验
    expect(result.request.tenantId).toBe(fx.tenantId);
    expect(result.request.threadId).toBe(fx.threadId);
    expect(result.request.turnId).toBe(fx.turnId);
    expect(result.request.invocationId).toBe(fx.invocationId);
    expect(result.request.requestType).toBe("confirmation");
    expect(result.request.purpose).toBe(HANDOFF_PURPOSE);
    expect(result.request.requestState).toBe("pending");
    expect(result.request.resolution).toBeNull();
    expect(result.request.itemId).toBe(result.item.id);

    // ThreadItem 校验
    expect(result.item.threadId).toBe(fx.threadId);
    expect(result.item.turnId).toBe(fx.turnId);
    expect(result.item.itemType).toBe("user_action");
    expect(result.item.itemState).toBe("completed");
    expect(result.item.authorType).toBe("system");
    expect(result.item.contentJson).toMatchObject({
      request_type: "confirmation",
      purpose: HANDOFF_PURPOSE,
      target_agent_id: fx.targetAgentId,
      previous_agent_id: fx.primaryAgentId,
      reason: "切换为风险审核 Agent",
      state: "pending",
    });

    // Invocation 转 waiting_user
    expect(result.invocation.executionState).toBe("waiting_user");

    // 3 条 Event（按 sequence 升序）
    expect(result.events).toHaveLength(3);
    expect(result.events[0]?.eventType).toBe("item.created");
    expect(result.events[0]?.itemId).toBe(result.item.id);
    expect(result.events[1]?.eventType).toBe("user_action.requested");
    expect(result.events[1]?.itemId).toBe(result.item.id);
    expect(result.events[1]?.payloadJson).toMatchObject({
      request_id: result.request.id,
      request_type: "confirmation",
      purpose: HANDOFF_PURPOSE,
      target_agent_id: fx.targetAgentId,
      previous_agent_id: fx.primaryAgentId,
    });
    expect(result.events[2]?.eventType).toBe("handoff.requested");
    expect(result.events[2]?.payloadJson).toMatchObject({
      request_id: result.request.id,
      thread_id: fx.threadId,
      previous_agent_id: fx.primaryAgentId,
      target_agent_id: fx.targetAgentId,
      reason: "切换为风险审核 Agent",
    });

    // Thread.primary_agent_id 未变（仅 requestHandoff 不修改）
    expect(result.thread.primaryAgentId).toBe(fx.primaryAgentId);

    // 数据库 Thread.primary_agent_id 仍为 primaryAgentId
    const [dbThread] = await db
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, fx.threadId))
      .limit(1);
    expect(dbThread?.primaryAgentId).toBe(fx.primaryAgentId);
  });

  it("actorType=service 时 ThreadItem.authorType 映射为 system", async () => {
    const fx = await seedHandoffFixture();

    const result = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "Workflow 触发 handoff",
      actorType: "service",
      actorId: "workflow-service",
    });

    expect(result.item.authorType).toBe("system");
    // Event.actorType 保留 service
    expect(result.events[0]?.actorType).toBe("service");
    expect(result.events[1]?.actorType).toBe("service");
    expect(result.events[2]?.actorType).toBe("service");
  });
});

// ─── requestHandoff 错误路径 ─────────────────────────────

describe("requestHandoff 错误路径", () => {
  it("同 Agent 抛 SAME_AGENT", async () => {
    const fx = await seedHandoffFixture();

    await expect(
      requestHandoff({
        tenantId: fx.tenantId,
        threadId: fx.threadId,
        invocationId: fx.invocationId,
        turnId: fx.turnId,
        targetAgentId: fx.primaryAgentId, // 同 Agent
        reason: "测试同 Agent",
      }),
    ).rejects.toMatchObject({
      name: "HandoffValidationError",
      code: "SAME_AGENT",
    });
  });

  it("目标 Agent 不存在抛 AGENT_NOT_AVAILABLE", async () => {
    const fx = await seedHandoffFixture();

    await expect(
      requestHandoff({
        tenantId: fx.tenantId,
        threadId: fx.threadId,
        invocationId: fx.invocationId,
        turnId: fx.turnId,
        targetAgentId: randomUUID(), // 不存在
        reason: "测试目标 Agent 不存在",
      }),
    ).rejects.toMatchObject({
      name: "HandoffValidationError",
      code: "AGENT_NOT_AVAILABLE",
    });
  });

  it("目标 Agent lifecycleState=disabled 抛 AGENT_NOT_AVAILABLE", async () => {
    const fx = await seedHandoffFixture();

    // 通过 updateAgentLifecycle 禁用目标 Agent
    await updateAgentLifecycle(fx.tenantId, fx.targetAgentId, "disabled", fx.targetAgent.versionNo);

    await expect(
      requestHandoff({
        tenantId: fx.tenantId,
        threadId: fx.threadId,
        invocationId: fx.invocationId,
        turnId: fx.turnId,
        targetAgentId: fx.targetAgentId,
        reason: "测试禁用 Agent",
      }),
    ).rejects.toMatchObject({
      name: "HandoffValidationError",
      code: "AGENT_NOT_AVAILABLE",
    });
  });

  it("Thread 不存在抛 ThreadNotFoundError", async () => {
    const fx = await seedHandoffFixture();

    await expect(
      requestHandoff({
        tenantId: fx.tenantId,
        threadId: randomUUID(), // 不存在
        invocationId: fx.invocationId,
        turnId: fx.turnId,
        targetAgentId: fx.targetAgentId,
        reason: "测试 Thread 不存在",
      }),
    ).rejects.toMatchObject({ name: "ThreadNotFoundError" });
  });

  it("Invocation 非 running 状态抛 INVOCATION_NOT_RUNNING", async () => {
    const fx = await seedHandoffFixture();

    // 将 Invocation 转 completed（终态，不可再触发 handoff）
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, fx.tenantId, fx.invocationId, "completed");
    });

    await expect(
      requestHandoff({
        tenantId: fx.tenantId,
        threadId: fx.threadId,
        invocationId: fx.invocationId,
        turnId: fx.turnId,
        targetAgentId: fx.targetAgentId,
        reason: "测试非 running Invocation",
      }),
    ).rejects.toMatchObject({
      name: "HandoffValidationError",
      code: "INVOCATION_NOT_RUNNING",
    });
  });
});

// ─── resolveHandoff approve 路径 ─────────────────────────

describe("resolveHandoff approve 路径", () => {
  it("员工 approve → Thread.primary_agent_id 变更 + 3 条 Event + resume command", async () => {
    const fx = await seedHandoffFixture();

    const reqResult = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "切换为 Target Agent",
      actorType: "system",
    });

    const result = await resolveHandoff({
      tenantId: fx.tenantId,
      requestId: reqResult.request.id,
      resolution: "approve",
      resolvedBy: fx.ownerId,
      actorType: "user",
      actorId: fx.ownerId,
      idempotencyKey: "handoff-approve-001",
    });

    // UserActionRequest 状态
    expect(result.request.requestState).toBe("resolved");
    expect(result.request.resolution).toBe("approve");
    expect(result.request.resolvedBy).toBe(fx.ownerId);
    expect(result.request.resolvedAt).toBeInstanceOf(Date);

    // Thread.primary_agent_id 变更
    expect(result.thread.primaryAgentId).toBe(fx.targetAgentId);
    expect(result.thread.primaryAgentId).not.toBe(fx.primaryAgentId);

    // Invocation 恢复 running
    expect(result.invocation.executionState).toBe("running");

    // handedOff=true
    expect(result.handedOff).toBe(true);

    // 3 条 Event：user_action.resolved + thread.primary_agent_changed + handoff.completed
    expect(result.events).toHaveLength(3);
    expect(result.events[0]?.eventType).toBe("user_action.resolved");
    expect(result.events[0]?.payloadJson).toMatchObject({
      request_id: reqResult.request.id,
      resolution: "approve",
      resolved_by: fx.ownerId,
    });
    expect(result.events[1]?.eventType).toBe("thread.primary_agent_changed");
    expect(result.events[1]?.payloadJson).toMatchObject({
      primary_agent_id: fx.targetAgentId,
      previous_agent_id: fx.primaryAgentId,
    });
    expect(result.events[2]?.eventType).toBe("handoff.completed");
    expect(result.events[2]?.payloadJson).toMatchObject({
      request_id: reqResult.request.id,
      previous_agent_id: fx.primaryAgentId,
      target_agent_id: fx.targetAgentId,
      resolution: "approve",
    });

    // resume command
    expect(result.resumeCommand.commandType).toBe("resume");
    expect(result.resumeCommand.commandState).toBe("queued");
    expect(result.resumeCommand.invocationId).toBe(fx.invocationId);
    expect(result.resumeCommand.threadId).toBe(fx.threadId);
    expect(result.resumeCommand.commandPayloadJson).toMatchObject({
      request_id: reqResult.request.id,
      resolution: "approve",
      handoff: {
        previous_agent_id: fx.primaryAgentId,
        target_agent_id: fx.targetAgentId,
      },
    });

    // 验证数据库 Thread.primary_agent_id 已持久化
    const [dbThread] = await db
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, fx.threadId))
      .limit(1);
    expect(dbThread?.primaryAgentId).toBe(fx.targetAgentId);
  });
});

// ─── resolveHandoff deny 路径 ────────────────────────────

describe("resolveHandoff deny 路径", () => {
  it("员工 deny → 主 Agent 不变 + 1 条 Event + resume command", async () => {
    const fx = await seedHandoffFixture();

    const reqResult = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "测试 deny",
      actorType: "system",
    });

    const result = await resolveHandoff({
      tenantId: fx.tenantId,
      requestId: reqResult.request.id,
      resolution: "deny",
      resolvedBy: fx.ownerId,
      actorType: "user",
      actorId: fx.ownerId,
      idempotencyKey: "handoff-deny-001",
    });

    // UserActionRequest 状态
    expect(result.request.requestState).toBe("resolved");
    expect(result.request.resolution).toBe("deny");
    expect(result.request.resolvedBy).toBe(fx.ownerId);

    // Thread.primary_agent_id 不变（核心不变量：拒绝时主 Agent 不变）
    expect(result.thread.primaryAgentId).toBe(fx.primaryAgentId);

    // Invocation 恢复 running
    expect(result.invocation.executionState).toBe("running");

    // handedOff=false
    expect(result.handedOff).toBe(false);

    // 1 条 Event：user_action.resolved（不写 thread.primary_agent_changed / handoff.completed）
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventType).toBe("user_action.resolved");
    expect(result.events[0]?.payloadJson).toMatchObject({
      request_id: reqResult.request.id,
      resolution: "deny",
      resolved_by: fx.ownerId,
    });

    // resume command
    expect(result.resumeCommand.commandType).toBe("resume");
    expect(result.resumeCommand.commandState).toBe("queued");
    expect(result.resumeCommand.commandPayloadJson).toMatchObject({
      request_id: reqResult.request.id,
      resolution: "deny",
      handoff_rejected: true,
    });

    // 数据库 Thread.primary_agent_id 不变
    const [dbThread] = await db
      .select()
      .from(v11Thread)
      .where(eq(v11Thread.id, fx.threadId))
      .limit(1);
    expect(dbThread?.primaryAgentId).toBe(fx.primaryAgentId);
  });

  it("deny 后再次 approve 同一请求 → 抛 HandoffAlreadyResolvedError", async () => {
    const fx = await seedHandoffFixture();

    const reqResult = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "测试幂等",
    });

    // 第一次 deny
    await resolveHandoff({
      tenantId: fx.tenantId,
      requestId: reqResult.request.id,
      resolution: "deny",
      resolvedBy: fx.ownerId,
    });

    // 第二次 approve（应抛错）
    await expect(
      resolveHandoff({
        tenantId: fx.tenantId,
        requestId: reqResult.request.id,
        resolution: "approve",
        resolvedBy: fx.ownerId,
      }),
    ).rejects.toMatchObject({ name: "HandoffAlreadyResolvedError" });
  });
});

// ─── resolveHandoff 错误路径 ─────────────────────────────

describe("resolveHandoff 错误路径", () => {
  it("UserActionRequest 不存在抛 ThreadNotFoundError", async () => {
    const fx = await seedHandoffFixture();

    await expect(
      resolveHandoff({
        tenantId: fx.tenantId,
        requestId: randomUUID(),
        resolution: "approve",
        resolvedBy: fx.ownerId,
      }),
    ).rejects.toMatchObject({ name: "ThreadNotFoundError" });
  });

  it("purpose 非 handoff 抛 HandoffValidationError PURPOSE_MISMATCH", async () => {
    const fx = await seedHandoffFixture();

    // 创建一个非 handoff 的 confirmation 请求（直接 INSERT 绕过 requestHandoff）
    const requestId = randomUUID();
    const itemId = randomUUID();
    await db.insert(v11ThreadItem).values({
      id: itemId,
      threadId: fx.threadId,
      turnId: fx.turnId,
      itemSequence: 2,
      itemType: "user_action",
      itemState: "completed",
      authorType: "system",
      authorId: null,
      contentJson: { request_type: "confirmation", purpose: "tool_confirm" },
      contentHash: "sha256:test",
      contextPolicy: "include",
    });
    await db.insert(v11UserActionRequest).values({
      id: requestId,
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      turnId: fx.turnId,
      invocationId: fx.invocationId,
      itemId,
      requestType: "confirmation",
      purpose: "tool_confirm", // 非 handoff
      requestState: "pending",
      promptJson: { title: "工具确认" },
    });

    await expect(
      resolveHandoff({
        tenantId: fx.tenantId,
        requestId,
        resolution: "approve",
        resolvedBy: fx.ownerId,
      }),
    ).rejects.toMatchObject({
      name: "HandoffValidationError",
      code: "PURPOSE_MISMATCH",
    });
  });

  it("非法 resolution 抛 HandoffValidationError RESOLUTION_NOT_ALLOWED", async () => {
    const fx = await seedHandoffFixture();

    await expect(
      resolveHandoff({
        tenantId: fx.tenantId,
        requestId: randomUUID(),
        resolution: "submit" as "approve", // confirmation 不接受 submit
        resolvedBy: fx.ownerId,
      }),
    ).rejects.toMatchObject({
      name: "HandoffValidationError",
      code: "RESOLUTION_NOT_ALLOWED",
    });
  });
});

// ─── 查询函数 ─────────────────────────────────────────────

describe("Handoff 查询函数", () => {
  it("getPendingHandoffRequest 返回 pending 请求；resolve 后返回 null", async () => {
    const fx = await seedHandoffFixture();

    // 初始无 pending
    expect(await getPendingHandoffRequest(fx.tenantId, fx.threadId)).toBeNull();

    const reqResult = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "测试查询",
    });

    // 有 pending
    const pending = await getPendingHandoffRequest(fx.tenantId, fx.threadId);
    expect(pending?.id).toBe(reqResult.request.id);
    expect(pending?.requestState).toBe("pending");

    // resolve 后无 pending
    await resolveHandoff({
      tenantId: fx.tenantId,
      requestId: reqResult.request.id,
      resolution: "approve",
      resolvedBy: fx.ownerId,
    });

    expect(await getPendingHandoffRequest(fx.tenantId, fx.threadId)).toBeNull();
  });

  it("listHandoffRequests 返回历史所有 handoff 请求（按 createdAt 升序）", async () => {
    const fx = await seedHandoffFixture();

    // 第一次 handoff（deny）
    const req1 = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "第一次 handoff",
    });
    await resolveHandoff({
      tenantId: fx.tenantId,
      requestId: req1.request.id,
      resolution: "deny",
      resolvedBy: fx.ownerId,
    });

    // 第二次 handoff（approve；deny 后主 Agent 仍为 primaryAgentId，可再次 handoff）
    const req2 = await requestHandoff({
      tenantId: fx.tenantId,
      threadId: fx.threadId,
      invocationId: fx.invocationId,
      turnId: fx.turnId,
      targetAgentId: fx.targetAgentId,
      reason: "第二次 handoff",
    });
    await resolveHandoff({
      tenantId: fx.tenantId,
      requestId: req2.request.id,
      resolution: "approve",
      resolvedBy: fx.ownerId,
    });

    const list = await listHandoffRequests(fx.tenantId, fx.threadId);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(req1.request.id);
    expect(list[1]?.id).toBe(req2.request.id);
    expect(list[0]?.createdAt.getTime()).toBeLessThanOrEqual(list[1]?.createdAt.getTime() ?? 0);
  });
});
