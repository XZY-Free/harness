/**
 * S09-C01 + S09-C02：Child Thread / Delegate 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - 查询：getChildThreadRelation / getRelationsByParentInvocation / getDelegateRelationsByParentThread
 * - getChildThreadResult：未完成返回 null resultItem
 * - requestChildThreadCancellation：active → cancel_requested + Event；幂等；终态拒绝
 * - projectChildThreadResult：子 Thread 终态 → 父 child_thread Item 投影 result；幂等；错误路径
 * - finalizeChildThreadCancellation：cancel_requested → cancelled；unknownEffect 路径；幂等
 * - handleChildThreadTerminal：按 completed/failed/cancelled 分派；skipped 路径
 * - recordChildThreadBudgetUsage / getChildThreadBudgetUsage / assertChildThreadBudgetNotExhausted：预算用量
 * - 子取消 ack 集成：requestChildThreadCancellation + 正式 event ingress → handleChildThreadTerminal
 *
 * 不变量（事实源：05 文档 §9 行 380-417、§16 行 580-595、§18 行 352-362；12 文档 §4）：
 * - 取消请求 ≠ 已取消（relation_state active → cancel_requested → cancelled）
 * - 完成投影幂等：子 Runtime 不能直接回写父 Thread；投影由平台根据子 Thread 终态生成
 * - unknown_effect 核对责任：子任务已产生 unknown effect 时不伪造无副作用取消
 * - 跨租户隔离：父 Thread 跨租户不可见
 *
 * 说明：委派创建链（delegateChildThread / executeChildThreadTask / computeDelegationDepth /
 * validateBudgetPolicy / validateContextTransferPolicy）已删除（专题01 冻结 Thread 无主 Agent）。
 * 本文件通过 seedDelegateChildThread 手写 INSERT 创建子 Thread + delegate ThreadRelation 完成 setup。
 */
import { randomUUID } from "node:crypto";
import {
  type DelegationBudgetPolicy,
  assertChildThreadBudgetNotExhausted,
  finalizeChildThreadCancellation,
  getChildThreadBudgetUsage,
  getChildThreadRelation,
  getChildThreadResult,
  getDelegateRelationsByParentThread,
  getRelationsByParentInvocation,
  handleChildThreadTerminal,
  projectChildThreadResult,
  recordChildThreadBudgetUsage,
  requestChildThreadCancellation,
} from "@/lib/conversations/child-thread-queries";
import {
  ChildInvocationNotTerminalError,
  ChildThreadAlreadyTerminalError,
  ChildThreadBudgetExhaustedError,
  ChildThreadCancellationFinalizeError,
  ChildThreadResultProjectionError,
  ThreadNotFoundError,
} from "@/lib/conversations/errors";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  threadEventTable,
  threadItemTable,
  threadRelationTable,
  threadTable,
} from "@/lib/persistence/schema/conversation";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import {
  createInvocation,
  getInvocationById,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import { and, eq } from "drizzle-orm";
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
  return { tenantId: tenant.id, ownerId: identity.id };
}

/** seed 父 Thread（createThread；Thread 已无 primaryAgentId，无需绑定 Agent）。 */
async function seedParentThread(tenantId: string, ownerId: string): Promise<{ threadId: string }> {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });
  return { threadId: thread.id };
}

/**
 * 手写 INSERT 创建 delegate 子 Thread + ThreadRelation（替代已删除的 delegateChildThread）。
 * 创建：child Thread（active）+ 父 Thread 的 child_thread Item + delegate ThreadRelation
 * （relationState=active, itemId 回填）。不写任何 Event（保留函数不依赖 Event 前置）。
 */
async function seedDelegateChildThread(params: {
  tenantId: string;
  ownerId: string;
  parentThreadId: string;
  parentInvocationId: string;
  targetAgentId: string;
  budgetPolicyJson?: DelegationBudgetPolicy;
}): Promise<{ childThreadId: string; relationId: string }> {
  const now = new Date();
  const childThreadId = randomUUID();

  // 1. child Thread（active，独立 Workspace）
  await db.insert(threadTable).values({
    id: childThreadId,
    tenantId: params.tenantId,
    ownerUserId: params.ownerId,
    title: "delegate child",
    lifecycleState: "active",
    lastActivityAt: now,
    lastTurnSequence: 0,
    lastItemSequence: 0,
    lastEventSequence: 1,
    pendingQueueVersionNo: 1,
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
  });

  // 2. 父 Thread 的 child_thread Item（relation.itemId 必须非空，projectChildThreadResult 依赖）
  const itemId = randomUUID();
  await db.insert(threadItemTable).values({
    id: itemId,
    threadId: params.parentThreadId,
    turnId: "", // schema notNull；无对应 Turn 时退化为空串占位
    itemSequence: 1,
    itemType: "child_thread",
    itemState: "pending",
    authorType: "system",
    authorId: params.ownerId,
    contentJson: { childThreadId, targetAgentId: params.targetAgentId, state: "active" },
    contentHash: "sha256:seed-child-thread",
    contextPolicy: "include",
    invocationId: params.parentInvocationId,
    supersededByItemId: null,
    createdAt: now,
    updatedAt: now,
  });

  // 3. delegate ThreadRelation（relationState=active，itemId 回填）
  const relationId = randomUUID();
  await db.insert(threadRelationTable).values({
    id: relationId,
    parentThreadId: params.parentThreadId,
    childThreadId,
    relationType: "delegate",
    sourceInvocationId: params.parentInvocationId,
    targetAgentId: params.targetAgentId,
    budgetPolicyJson: params.budgetPolicyJson as unknown as Record<string, unknown> | null,
    relationState: "active",
    itemId,
    createdAt: now,
  });

  return { childThreadId, relationId };
}

// ─── 查询函数 ─────────────────────────────────────────────

describe("Child Thread 查询函数", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
    });
    relationId = seed.relationId;
  });

  it("getChildThreadRelation 按 id 查询存在", async () => {
    const relation = await getChildThreadRelation(relationId);
    expect(relation).not.toBeNull();
    expect(relation?.id).toBe(relationId);
    expect(relation?.relationType).toBe("delegate");
  });

  it("getChildThreadRelation 不存在返回 null", async () => {
    const relation = await getChildThreadRelation(randomUUID());
    expect(relation).toBeNull();
  });

  it("getRelationsByParentInvocation 按 parent Invocation 查询", async () => {
    const relations = await getRelationsByParentInvocation(tenantId, parentInvocationId);
    expect(relations).toHaveLength(1);
    expect(relations[0]?.id).toBe(relationId);
  });

  it("getRelationsByParentInvocation 无匹配返回空数组", async () => {
    const relations = await getRelationsByParentInvocation(tenantId, randomUUID());
    expect(relations).toHaveLength(0);
  });

  it("getDelegateRelationsByParentThread 按 parent Thread 查询", async () => {
    const relations = await getDelegateRelationsByParentThread(tenantId, parentThreadId);
    expect(relations).toHaveLength(1);
    expect(relations[0]?.id).toBe(relationId);
  });

  it("getChildThreadResult 非 completed 状态返回 resultItem=null", async () => {
    const result = await getChildThreadResult(relationId);
    expect(result).not.toBeNull();
    expect(result?.relation.relationState).toBe("active");
    expect(result?.resultItem).toBeNull();
  });

  it("getChildThreadResult relation 不存在返回 null", async () => {
    const result = await getChildThreadResult(randomUUID());
    expect(result).toBeNull();
  });
});

// ─── 取消请求 ─────────────────────────────────────────────

describe("requestChildThreadCancellation 取消请求", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
    });
    relationId = seed.relationId;
    childThreadId = seed.childThreadId;
  });

  it("成功请求取消：relation active → cancel_requested + 写父 Thread Event", async () => {
    const result = await requestChildThreadCancellation({
      tenantId,
      parentThreadId,
      relationId,
      reason: "user_requested",
      actorId: ownerId,
    });

    expect(result.initiated).toBe(true);
    expect(result.relation.relationState).toBe("cancel_requested");
    expect(result.cancelRequestedEvent).not.toBeNull();
    expect(result.cancelRequestedEvent?.threadId).toBe(parentThreadId);
    expect(result.cancelRequestedEvent?.eventType).toBe("child_thread.cancel_requested");
    expect(result.cancelRequestedEvent?.payloadJson).toMatchObject({
      relation_id: relationId,
      child_thread_id: childThreadId,
      parent_thread_id: parentThreadId,
      reason: "user_requested",
    });

    // DB 校验：relation_state 已更新
    const dbRelation = await getChildThreadRelation(relationId);
    expect(dbRelation?.relationState).toBe("cancel_requested");
  });

  it("幂等：重复请求取消 → initiated=false，不重复写 Event", async () => {
    const first = await requestChildThreadCancellation({
      tenantId,
      parentThreadId,
      relationId,
      actorId: ownerId,
    });
    expect(first.initiated).toBe(true);

    const second = await requestChildThreadCancellation({
      tenantId,
      parentThreadId,
      relationId,
      actorId: ownerId,
    });
    expect(second.initiated).toBe(false);
    expect(second.cancelRequestedEvent).toBeNull();
    expect(second.relation.relationState).toBe("cancel_requested");
  });

  it("终态 relation 拒绝取消 → ChildThreadAlreadyTerminalError", async () => {
    // 手动将 relation 状态改为 completed（绕过状态机校验，模拟 Runtime 完成场景）
    await db
      .update(threadRelationTable)
      .set({ relationState: "completed", completedAt: new Date() })
      .where(eq(threadRelationTable.id, relationId));

    await expect(
      requestChildThreadCancellation({
        tenantId,
        parentThreadId,
        relationId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ChildThreadAlreadyTerminalError);
  });

  it("cancelled 终态同样拒绝取消", async () => {
    await db
      .update(threadRelationTable)
      .set({ relationState: "cancelled", completedAt: new Date() })
      .where(eq(threadRelationTable.id, relationId));

    await expect(
      requestChildThreadCancellation({
        tenantId,
        parentThreadId,
        relationId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ChildThreadAlreadyTerminalError);
  });

  it("relation 不存在 → ThreadNotFoundError", async () => {
    await expect(
      requestChildThreadCancellation({
        tenantId,
        parentThreadId,
        relationId: randomUUID(),
        actorId: ownerId,
      }),
    ).rejects.toThrow(ThreadNotFoundError);
  });

  it("relation 跨父 Thread → ThreadNotFoundError（隐藏式）", async () => {
    await expect(
      requestChildThreadCancellation({
        tenantId,
        parentThreadId: randomUUID(), // 不存在的父 Thread
        relationId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ThreadNotFoundError);
  });
});

// ─── S09-C02: projectChildThreadResult ────────────────────

/**
 * 在子 Thread 上创建 completed assistant_message Item，模拟子 Thread 终态结果。
 * 同时为子 Thread 创建一条 completed Invocation 以满足 projectChildThreadResult 前置条件。
 */
async function seedChildThreadCompletedResult(
  tenantId: string,
  childThreadId: string,
  agentId: string,
  ownerUserId: string,
  messageText: string,
): Promise<{ itemId: string; invocationId: string; turnId: string }> {
  // 1. 在子 Thread 上 acceptUserMessageTurn
  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: childThreadId,
    ownerUserId,
    content: { text: "子任务输入" } as unknown as Parameters<
      typeof acceptUserMessageTurn
    >[0]["content"],
    actorId: ownerUserId,
  });

  // 2. 创建 Invocation 并转 running → completed
  const { invocation } = await createInvocation({
    tenantId,
    threadId: childThreadId,
    turnId: turn.id,
    invocationKind: "initial",
    triggerItemId: turn.triggerItemId,
    actorType: "system",
  });
  let completedInvocation = invocation;
  await db.transaction(async (tx) => {
    completedInvocation = await updateInvocationState(tx, tenantId, invocation.id, "running");
  });
  await db.transaction(async (tx) => {
    completedInvocation = await updateInvocationState(tx, tenantId, invocation.id, "completed");
  });

  // 3. 创建 assistant_message Item（itemState=completed）
  const itemId = randomUUID();

  // 直接 INSERT 一个 completed assistant_message Item
  const [threadRow] = await db
    .select()
    .from(threadTable)
    .where(eq(threadTable.id, childThreadId))
    .limit(1);
  if (!threadRow) throw new Error("子 Thread 不存在");

  // 分配 itemSequence
  const itemSequence = threadRow.lastItemSequence + 1;
  await db
    .update(threadTable)
    .set({ lastItemSequence: itemSequence })
    .where(eq(threadTable.id, childThreadId));

  const contentJson = { text: messageText, agent_id: agentId };
  const contentHash = `sha256:${messageText}`;
  await db.insert(threadItemTable).values({
    id: itemId,
    threadId: childThreadId,
    turnId: turn.id,
    itemSequence,
    itemType: "assistant_message",
    itemState: "completed",
    authorType: "assistant",
    authorId: agentId,
    contentJson,
    contentHash,
    contextPolicy: "include",
    invocationId: completedInvocation.id,
    supersededByItemId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { itemId, invocationId: completedInvocation.id, turnId: turn.id };
}

describe("projectChildThreadResult 结果投影", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;
  let childThreadId: string;
  let childItemId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
    });
    relationId = seed.relationId;
    childThreadId = seed.childThreadId;

    // 在子 Thread 上创建 completed assistant_message Item
    const seeded = await seedChildThreadCompletedResult(
      tenantId,
      childThreadId,
      targetAgentId,
      ownerId,
      "子任务结果摘要",
    );
    childItemId = seeded.itemId;
  });

  it("成功投影：relation → completed + 父 child_thread Item 更新 + Event", async () => {
    const result = await projectChildThreadResult({
      tenantId,
      relationId,
      actorType: "system",
    });

    expect(result.relation.relationState).toBe("completed");
    expect(result.relation.resultItemId).toBe(childItemId);
    expect(result.relation.resultRef).toBe(`result:child-thread:${relationId}:1`);
    expect(result.relation.resultHash).toMatch(/^sha256:/);
    expect(result.relation.completedAt).not.toBeNull();

    // 父 child_thread Item 更新
    expect(result.item.id).toBe(result.relation.itemId);
    expect(result.item.itemState).toBe("completed");
    const content = result.item.contentJson as Record<string, unknown>;
    expect(content.state).toBe("completed");
    expect(content.resultRef).toBe(`result:child-thread:${relationId}:1`);
    expect(content.summary).toBe("子任务结果摘要");
    expect(content.completedAt).toBeDefined();

    // Event
    expect(result.completedEvent.eventType).toBe("child_thread.completed");
    expect(result.completedEvent.threadId).toBe(parentThreadId);
    expect(result.completedEvent.payloadJson).toMatchObject({
      relation_id: relationId,
      child_thread_id: childThreadId,
      result_item_id: childItemId,
    });
  });

  it("幂等：重复调用 → 不重复写 Event，返回当前状态", async () => {
    const first = await projectChildThreadResult({
      tenantId,
      relationId,
      actorType: "system",
    });
    expect(first.relation.relationState).toBe("completed");

    const second = await projectChildThreadResult({
      tenantId,
      relationId,
      actorType: "system",
    });
    expect(second.relation.relationState).toBe("completed");
    // 幂等命中不返回新 Event
    expect(second.completedEvent).toBeNull();
    expect(second.relation.resultItemId).toBe(first.relation.resultItemId);
  });

  it("子 Invocation 未终态 → ChildInvocationNotTerminalError", async () => {
    // 在子 Thread 上创建一个 running Invocation（覆盖原 completed Invocation）
    // projectChildThreadResult 会取最新 Invocation 校验
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: childThreadId,
      ownerUserId: ownerId,
      content: { text: "第二次输入" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation } = await createInvocation({
      tenantId,
      threadId: childThreadId,
      turnId: turn.id,
      invocationKind: "initial",
      triggerItemId: turn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "running");
    });

    await expect(
      projectChildThreadResult({
        tenantId,
        relationId,
        actorType: "system",
      }),
    ).rejects.toThrow(ChildInvocationNotTerminalError);
  });

  it("relation 已 cancelled → ChildThreadAlreadyTerminalError", async () => {
    // 先 finalize 取消
    await db
      .update(threadRelationTable)
      .set({ relationState: "cancelled", completedAt: new Date() })
      .where(eq(threadRelationTable.id, relationId));

    await expect(
      projectChildThreadResult({
        tenantId,
        relationId,
        actorType: "system",
      }),
    ).rejects.toThrow(ChildThreadAlreadyTerminalError);
  });

  it("relation 不存在 → ChildThreadResultProjectionError", async () => {
    await expect(
      projectChildThreadResult({
        tenantId,
        relationId: randomUUID(),
        actorType: "system",
      }),
    ).rejects.toThrow(ChildThreadResultProjectionError);
  });
});

// ─── S09-C02: finalizeChildThreadCancellation ─────────────

describe("finalizeChildThreadCancellation 取消终态落库", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
    });
    relationId = seed.relationId;
    childThreadId = seed.childThreadId;
  });

  it("成功 finalize：cancel_requested → cancelled + 父子流 Event", async () => {
    // 先发起取消请求
    await requestChildThreadCancellation({
      tenantId,
      parentThreadId,
      relationId,
      reasonCode: "PARENT_NO_LONGER_NEEDS_RESULT",
      actorId: ownerId,
    });

    // 子 Thread 上创建 Invocation 并转 cancelled（满足 unknownEffect=false 终态校验）
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: childThreadId,
      ownerUserId: ownerId,
      content: { text: "子任务输入" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation } = await createInvocation({
      tenantId,
      threadId: childThreadId,
      turnId: turn.id,
      invocationKind: "initial",
      triggerItemId: turn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "running");
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "cancelled");
    });

    const result = await finalizeChildThreadCancellation({
      tenantId,
      relationId,
      unknownEffect: false,
      reasonCode: "PARENT_NO_LONGER_NEEDS_RESULT",
      actorType: "user",
    });

    expect(result.relation.relationState).toBe("cancelled");
    expect(result.relation.completedAt).not.toBeNull();

    // 父 Thread child_thread.cancelled Event
    expect(result.parentCancelledEvent.threadId).toBe(parentThreadId);
    expect(result.parentCancelledEvent.eventType).toBe("child_thread.cancelled");
    expect(result.parentCancelledEvent.payloadJson).toMatchObject({
      relation_id: relationId,
      child_thread_id: childThreadId,
      unknown_effect: false,
      reason_code: "PARENT_NO_LONGER_NEEDS_RESULT",
    });

    // 子 Thread child_thread.cancelled Event（from_parent=true）
    expect(result.childCancelledEvent.threadId).toBe(childThreadId);
    expect(result.childCancelledEvent.eventType).toBe("child_thread.cancelled");
    expect(result.childCancelledEvent.payloadJson).toMatchObject({
      relation_id: relationId,
      from_parent: true,
      unknown_effect: false,
    });

    // DB 校验
    const dbRelation = await getChildThreadRelation(relationId);
    expect(dbRelation?.relationState).toBe("cancelled");
  });

  it("unknownEffect=true 跳过子 Invocation 终态校验", async () => {
    // 子 Thread 上创建 running Invocation（未终态）
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: childThreadId,
      ownerUserId: ownerId,
      content: { text: "子任务输入" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation } = await createInvocation({
      tenantId,
      threadId: childThreadId,
      turnId: turn.id,
      invocationKind: "initial",
      triggerItemId: turn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "running");
    });

    // unknownEffect=true 应直接通过，不校验子 Invocation 终态
    const result = await finalizeChildThreadCancellation({
      tenantId,
      relationId,
      unknownEffect: true,
      reasonCode: "PARENT_CANCELLED",
      actorType: "user",
    });

    expect(result.relation.relationState).toBe("cancelled");
    expect(result.parentCancelledEvent.payloadJson).toMatchObject({
      unknown_effect: true,
    });
    expect(result.childCancelledEvent.payloadJson).toMatchObject({
      unknown_effect: true,
      from_parent: true,
    });
  });

  it("unknownEffect=false 子 Invocation 未终态 → ChildInvocationNotTerminalError", async () => {
    // 子 Thread 上创建 running Invocation
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: childThreadId,
      ownerUserId: ownerId,
      content: { text: "子任务输入" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation } = await createInvocation({
      tenantId,
      threadId: childThreadId,
      turnId: turn.id,
      invocationKind: "initial",
      triggerItemId: turn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "running");
    });

    await expect(
      finalizeChildThreadCancellation({
        tenantId,
        relationId,
        unknownEffect: false,
        actorType: "user",
      }),
    ).rejects.toThrow(ChildInvocationNotTerminalError);
  });

  it("幂等：relation 已 cancelled → 不重复写 Event", async () => {
    // 先直接 DB 标记 cancelled
    await db
      .update(threadRelationTable)
      .set({ relationState: "cancelled", completedAt: new Date() })
      .where(eq(threadRelationTable.id, relationId));

    const result = await finalizeChildThreadCancellation({
      tenantId,
      relationId,
      unknownEffect: true,
      actorType: "user",
    });

    expect(result.relation.relationState).toBe("cancelled");
    expect(result.parentCancelledEvent).toBeNull();
    expect(result.childCancelledEvent).toBeNull();
  });

  it("relation 已 completed → ChildThreadAlreadyTerminalError", async () => {
    await db
      .update(threadRelationTable)
      .set({ relationState: "completed", completedAt: new Date() })
      .where(eq(threadRelationTable.id, relationId));

    await expect(
      finalizeChildThreadCancellation({
        tenantId,
        relationId,
        unknownEffect: true,
        actorType: "user",
      }),
    ).rejects.toThrow(ChildThreadAlreadyTerminalError);
  });

  it("relation 不存在 → ChildThreadCancellationFinalizeError", async () => {
    await expect(
      finalizeChildThreadCancellation({
        tenantId,
        relationId: randomUUID(),
        unknownEffect: true,
        actorType: "user",
      }),
    ).rejects.toThrow(ChildThreadCancellationFinalizeError);
  });
});

// ─── S09-C02: handleChildThreadTerminal ───────────────────

describe("handleChildThreadTerminal 终态协调器", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
    });
    relationId = seed.relationId;
    childThreadId = seed.childThreadId;
  });

  it("completed 分派 → 调用 projectChildThreadResult", async () => {
    // 在子 Thread 上创建 completed assistant_message Item + completed Invocation
    await seedChildThreadCompletedResult(
      tenantId,
      childThreadId,
      targetAgentId,
      ownerId,
      "协调器完成结果",
    );

    const result = await handleChildThreadTerminal({
      tenantId,
      childThreadId,
      terminalState: "completed",
      actorType: "system",
    });

    expect(result.action).toBe("completed");
    expect(result.relation.relationState).toBe("completed");
    expect(result.projection).toBeDefined();
    expect(result.projection?.relation.resultRef).toBe(`result:child-thread:${relationId}:1`);
  });

  it("cancelled 分派 → 调用 finalizeChildThreadCancellation", async () => {
    // 子 Thread 上创建 cancelled Invocation 满足 unknownEffect=false
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: childThreadId,
      ownerUserId: ownerId,
      content: { text: "子任务输入" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation } = await createInvocation({
      tenantId,
      threadId: childThreadId,
      turnId: turn.id,
      invocationKind: "initial",
      triggerItemId: turn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "running");
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, invocation.id, "cancelled");
    });

    const result = await handleChildThreadTerminal({
      tenantId,
      childThreadId,
      terminalState: "cancelled",
      unknownEffect: false,
      reasonCode: "PARENT_CANCELLED",
      actorType: "system",
    });

    expect(result.action).toBe("cancelled");
    expect(result.relation.relationState).toBe("cancelled");
    expect(result.cancellation).toBeDefined();
  });

  it("skipped：子 Thread 非 delegate → action=skipped", async () => {
    // 创建一个独立的 Thread（非 delegate 子 Thread）
    const { thread } = await createThread({
      tenantId,
      ownerUserId: ownerId,
      actorId: ownerId,
    });

    const result = await handleChildThreadTerminal({
      tenantId,
      childThreadId: thread.id,
      terminalState: "completed",
      actorType: "system",
    });

    expect(result.action).toBe("skipped");
  });

  it("skipped：relation 已终态 → 幂等 skipped", async () => {
    // 先 DB 标记 completed
    await db
      .update(threadRelationTable)
      .set({ relationState: "completed", completedAt: new Date() })
      .where(eq(threadRelationTable.id, relationId));

    const result = await handleChildThreadTerminal({
      tenantId,
      childThreadId,
      terminalState: "completed",
      actorType: "system",
    });

    expect(result.action).toBe("skipped");
    expect(result.relation.relationState).toBe("completed");
  });
});

// ─── S09-C02: 预算用量 ───────────────────────────────────

describe("Child Thread 预算用量", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
      budgetPolicyJson: { maxTokens: 1000, maxCost: 5, maxWallClockMs: 60000 },
    });
    relationId = seed.relationId;
  });

  it("recordChildThreadBudgetUsage 累积用量", async () => {
    const first = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { tokens: 300, cost: 1.5, toolCalls: 5, wallClockMs: 10000 },
    });

    expect(first.budgetUsed.tokens).toBe(300);
    expect(first.budgetUsed.cost).toBe(1.5);
    expect(first.budgetUsed.toolCalls).toBe(5);
    expect(first.budgetUsed.wallClockMs).toBe(10000);
    expect(first.exhausted).toBe(false);

    const second = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { tokens: 400, cost: 2 },
    });

    expect(second.budgetUsed.tokens).toBe(700);
    expect(second.budgetUsed.cost).toBe(3.5);
    expect(second.budgetUsed.toolCalls).toBe(5); // 不传则保留原值
    expect(second.budgetUsed.wallClockMs).toBe(10000);
    expect(second.exhausted).toBe(false);
  });

  it("recordChildThreadBudgetUsage 超过 maxTokens → exhausted=true + exceededField=tokens", async () => {
    const result = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { tokens: 1500 }, // 超过 maxTokens=1000
    });

    expect(result.exhausted).toBe(true);
    expect(result.exceededField).toBe("tokens");
  });

  it("recordChildThreadBudgetUsage 超过 maxCost → exhausted=true + exceededField=cost", async () => {
    const result = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { cost: 10 }, // 超过 maxCost=5
    });

    expect(result.exhausted).toBe(true);
    expect(result.exceededField).toBe("cost");
  });

  it("recordChildThreadBudgetUsage 超过 maxWallClockMs → exhausted=true + exceededField=wall_clock_ms", async () => {
    const result = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { wallClockMs: 70000 }, // 超过 maxWallClockMs=60000
    });

    expect(result.exhausted).toBe(true);
    expect(result.exceededField).toBe("wall_clock_ms");
  });

  it("recordChildThreadBudgetUsage unknownEffect 取或", async () => {
    await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { unknownEffect: true },
    });

    const usage = await getChildThreadBudgetUsage(relationId);
    expect(usage?.unknownEffect).toBe(true);

    // 再次累积 false 不会清除 true
    await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { unknownEffect: false },
    });
    const usage2 = await getChildThreadBudgetUsage(relationId);
    expect(usage2?.unknownEffect).toBe(true);
  });

  it("getChildThreadBudgetUsage 未累积返回 null", async () => {
    const usage = await getChildThreadBudgetUsage(relationId);
    expect(usage).toBeNull();
  });

  it("getChildThreadBudgetUsage relation 不存在返回 null", async () => {
    const usage = await getChildThreadBudgetUsage(randomUUID());
    expect(usage).toBeNull();
  });

  it("assertChildThreadBudgetNotExhausted 未超限通过", async () => {
    await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { tokens: 500 },
    });

    // 不抛错
    await assertChildThreadBudgetNotExhausted(relationId);
  });

  it("assertChildThreadBudgetNotExhausted 超限 → ChildThreadBudgetExhaustedError", async () => {
    await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { tokens: 1500 }, // 超过 maxTokens=1000
    });

    await expect(assertChildThreadBudgetNotExhausted(relationId)).rejects.toThrow(
      ChildThreadBudgetExhaustedError,
    );
  });

  it("assertChildThreadBudgetNotExhausted relation 不存在 → ThreadNotFoundError", async () => {
    await expect(assertChildThreadBudgetNotExhausted(randomUUID())).rejects.toThrow(
      ThreadNotFoundError,
    );
  });

  it("recordChildThreadBudgetUsage relation 不存在 → ThreadNotFoundError", async () => {
    await expect(
      recordChildThreadBudgetUsage({
        tenantId,
        relationId: randomUUID(),
        delta: { tokens: 100 },
      }),
    ).rejects.toThrow(ThreadNotFoundError);
  });
});

// ─── 子取消 ack 集成：requestChildThreadCancellation + 正式 event ingress ───

describe("子取消 ack 集成（requestChildThreadCancellation + ingress execution.cancelled）", () => {
  let tenantId: string;
  let ownerId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let targetAgentId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    targetAgentId = randomUUID();

    const parent = await seedParentThread(tenantId, ownerId);
    parentThreadId = parent.threadId;
    parentInvocationId = randomUUID();

    const seed = await seedDelegateChildThread({
      tenantId,
      ownerId,
      parentThreadId,
      parentInvocationId,
      targetAgentId,
    });
    relationId = seed.relationId;
    childThreadId = seed.childThreadId;
  });

  it("Runtime ack 前 relation=cancel_requested；ack 后（ingress）relation=cancelled", async () => {
    // 在子 Thread 上创建 child Turn + queued child Invocation，并转 running（正式状态机）。
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: childThreadId,
      ownerUserId: ownerId,
      content: { text: "子任务待取消" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation: childInvocation } = await createInvocation({
      tenantId,
      threadId: childThreadId,
      turnId: turn.id,
      invocationKind: "initial",
      triggerItemId: turn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, childInvocation.id, "running");
    });

    // 父请求取消 → relation active→cancel_requested + 入队 cancel command。
    await requestChildThreadCancellation({
      tenantId,
      parentThreadId,
      relationId,
      reason: "集成取消 ack",
      reasonCode: "PARENT_NO_LONGER_NEEDS_RESULT",
    });
    const preAckRelation = await getChildThreadRelation(relationId);
    expect(preAckRelation?.relationState).toBe("cancel_requested");
    const preAckInvocation = await getInvocationById(tenantId, childInvocation.id);
    expect(preAckInvocation?.executionState).not.toBe("cancelled");

    // 子 Runtime 经正式 ingress 回传 execution.cancelled → post-commit
    // handleChildThreadTerminal(cancelled) → finalizeChildThreadCancellation。
    await ingressEventBatch({
      tenantId,
      invocationId: childInvocation.id,
      producerSequenceStart: 1,
      events: [
        {
          producer_event_id: `evt-cancel-${randomUUID()}`,
          producer_sequence: 1,
          type: "execution.cancelled",
          payload: { cancelled_by: "parent" },
        },
      ],
    });

    const postAckInvocation = await getInvocationById(tenantId, childInvocation.id);
    expect(postAckInvocation?.executionState).toBe("cancelled");
    const postAckRelation = await getChildThreadRelation(relationId);
    expect(postAckRelation?.relationState).toBe("cancelled");

    // 事件顺序稳定：cancel_requested 早于 cancelled。
    const cancelRequested = await db
      .select()
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, parentThreadId),
          eq(threadEventTable.eventType, "child_thread.cancel_requested"),
        ),
      );
    const cancelled = await db
      .select()
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, parentThreadId),
          eq(threadEventTable.eventType, "child_thread.cancelled"),
        ),
      );
    expect(cancelRequested.length).toBe(1);
    expect(cancelled.length).toBe(1);
    expect(cancelRequested[0]?.eventSequence).toBeLessThan(
      cancelled[0]?.eventSequence ?? Number.POSITIVE_INFINITY,
    );
  });
});
