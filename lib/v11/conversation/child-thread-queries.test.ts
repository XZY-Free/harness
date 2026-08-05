/**
 * S09-C01 + S09-C02：V11 Child Thread / Delegate 仓储集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - delegateChildThread：成功 + 子 Thread + delegate 关系 + 两条 Event + policy 校验
 *   （parent Invocation 非 running / target Agent 不在 allowedTargets / 深度超限 /
 *    budget 负值 / contextTransferPolicy 含 sensitive Item）
 * - 查询：getChildThreadRelation / getRelationsByParentInvocation / getDelegateRelationsByParentThread
 * - getChildThreadResult：未完成返回 null resultItem
 * - requestChildThreadCancellation：active → cancel_requested + Event；幂等；终态拒绝
 * - computeDelegationDepth：root=0；一级=1；二级=2
 * - projectChildThreadResult：子 Thread 终态 → 父 child_thread Item 投影 result；幂等；错误路径
 * - finalizeChildThreadCancellation：cancel_requested → cancelled；unknownEffect 路径；幂等
 * - handleChildThreadTerminal：按 completed/failed/cancelled 分派；skipped 路径
 * - recordChildThreadBudgetUsage / getChildThreadBudgetUsage / assertChildThreadBudgetNotExhausted：预算用量
 *
 * 不变量（事实源：05 文档 §9 行 380-417、§16 行 580-595、§18 行 352-362；12 文档 §4）：
 * - 只有 running 状态父 Invocation 可委派
 * - target_agent_id 必须在父 Agent delegationPolicyJson.allowedTargets 中
 * - 委派深度 + 1 <= maxDepth
 * - 取消请求 ≠ 已取消（relation_state active → cancel_requested → cancelled）
 * - 完成投影幂等：子 Runtime 不能直接回写父 Thread；投影由平台根据子 Thread 终态生成
 * - unknown_effect 核对责任：子任务已产生 unknown effect 时不伪造无副作用取消
 * - 跨租户隔离：父 Thread 跨租户不可见
 */
import { randomUUID } from "node:crypto";
import { createAgent, getAgentById } from "@/lib/agents/persistence/agent-queries";
import { createDraftRevision } from "@/lib/agents/persistence/agent-revision-queries";
import { publishRevision } from "@/lib/agents/test-support/publish-agent-revision-without-attestation";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  type ContextTransferPolicy,
  type DelegationBudgetPolicy,
  assertChildThreadBudgetNotExhausted,
  computeDelegationDepth,
  delegateChildThread,
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
} from "@/lib/v11/conversation/child-thread-queries";
import {
  ChildBudgetExceededError,
  ChildContextNotAllowedError,
  ChildInvocationNotTerminalError,
  ChildThreadAlreadyTerminalError,
  ChildThreadBudgetExhaustedError,
  ChildThreadCancellationFinalizeError,
  ChildThreadResultProjectionError,
  DelegationDepthExceededError,
  DelegationNotAllowedError,
  ParentInvocationNotActiveError,
  ThreadNotFoundError,
} from "@/lib/v11/conversation/errors";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { createInvocation, updateInvocationState } from "@/lib/v11/runtime/invocation-queries";
import { v11ThreadItem, v11ThreadRelation } from "@/lib/v11/schema/conversation";
import { eq } from "drizzle-orm";
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

/** seed Agent 并发布带 delegationPolicyJson 的 Revision。 */
async function seedAgentWithDelegationPolicy(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  delegationPolicy: { allowedTargets: string[]; maxDepth?: number },
): Promise<{ agentId: string; revisionId: string }> {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `${agentKey} Agent`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });
  const draft = await createDraftRevision({
    tenantId,
    agentId: agent.id,
    sourceType: "agent_yaml",
    sourceRevision: "git_commit_1",
    instructionHash: "sha256:instruction_1",
    agentArtifactRef: "oci://registry/agent@sha256:abc",
    modelPolicyJson: { default: "doubao-pro" },
    permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
    delegationPolicyJson: delegationPolicy,
    agentInterfaceRequirementsJson: { required: ["event_stream"], optional: ["steer"] },
    createdBy: ownerId,
  });
  const published = await publishRevision(tenantId, draft.id, 1);
  return { agentId: agent.id, revisionId: published.id };
}

/** seed Agent 但不发布 Revision（用于 target Agent 不需要 delegationPolicy 的场景）。 */
async function seedEnabledAgent(
  tenantId: string,
  ownerId: string,
  agentKey: string,
): Promise<string> {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `${agentKey} Agent`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });
  return agent.id;
}

/** seed Thread + Turn + queued Invocation，并转 running。 */
async function seedThreadWithRunningInvocation(
  tenantId: string,
  ownerId: string,
  agentId: string,
): Promise<{
  threadId: string;
  turnId: string;
  invocationId: string;
}> {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    primaryAgentId: agentId,
    actorId: ownerId,
  });
  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "测试委派消息" } as unknown as Parameters<
      typeof acceptUserMessageTurn
    >[0]["content"],
    actorId: ownerId,
  });
  const { invocation } = await createInvocation({
    tenantId,
    threadId: thread.id,
    turnId: turn.id,
    invocationKind: "initial",
    triggerItemId: turn.triggerItemId,
    actorType: "system",
  });

  // 转入 running 状态（updateInvocationState 需在事务内调用）
  let runningInvocation = invocation;
  await db.transaction(async (tx) => {
    runningInvocation = await updateInvocationState(tx, tenantId, invocation.id, "running");
  });

  return { threadId: thread.id, turnId: turn.id, invocationId: runningInvocation.id };
}

// ─── delegateChildThread 成功路径 ─────────────────────────

describe("delegateChildThread 成功路径", () => {
  let tenantId: string;
  let ownerId: string;
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;
  });

  it("成功创建 delegate Child Thread + 关系 + 两条 Event", async () => {
    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      taskPayloadRef: "artifact://task/123",
      taskPayloadHash: "sha256:task_hash_1",
      contextTransferPolicyJson: { mode: "minimal" },
      budgetPolicyJson: { maxTokens: 10000, maxWallClockMs: 60000 },
      actorId: ownerId,
    });

    // 子 Thread 校验
    expect(result.thread.id).not.toBe(parentThreadId);
    expect(result.thread.tenantId).toBe(tenantId);
    expect(result.thread.ownerUserId).toBe(ownerId);
    expect(result.thread.primaryAgentId).toBe(targetAgentId);
    expect(result.thread.lifecycleState).toBe("active");
    expect(result.thread.lastEventSequence).toBe(1);
    expect(result.thread.lastTurnSequence).toBe(0);
    expect(result.thread.lastItemSequence).toBe(0);

    // ThreadRelation 校验
    expect(result.relation.parentThreadId).toBe(parentThreadId);
    expect(result.relation.childThreadId).toBe(result.thread.id);
    expect(result.relation.relationType).toBe("delegate");
    expect(result.relation.relationState).toBe("active");
    expect(result.relation.sourceInvocationId).toBe(parentInvocationId);
    expect(result.relation.targetAgentId).toBe(targetAgentId);
    expect(result.relation.taskPayloadRef).toBe("artifact://task/123");
    expect(result.relation.taskPayloadHash).toBe("sha256:task_hash_1");
    expect(result.relation.contextTransferPolicyJson).toEqual({ mode: "minimal" });
    expect(result.relation.budgetPolicyJson).toEqual({
      maxTokens: 10000,
      maxWallClockMs: 60000,
    });
    expect(result.relation.completedAt).toBeNull();

    // 子 thread.created Event
    expect(result.childCreatedEvent.threadId).toBe(result.thread.id);
    expect(result.childCreatedEvent.eventType).toBe("thread.created");
    expect(result.childCreatedEvent.eventSequence).toBe(1);
    expect(result.childCreatedEvent.actorType).toBe("user");
    expect(result.childCreatedEvent.actorId).toBe(ownerId);
    expect(result.childCreatedEvent.payloadJson).toMatchObject({
      delegate_child: true,
      parent_thread_id: parentThreadId,
      parent_invocation_id: parentInvocationId,
      primary_agent_id: targetAgentId,
    });

    // 父 child_thread.created Event
    expect(result.parentChildThreadCreatedEvent.threadId).toBe(parentThreadId);
    expect(result.parentChildThreadCreatedEvent.eventType).toBe("child_thread.created");
    expect(result.parentChildThreadCreatedEvent.eventSequence).toBeGreaterThan(1);
    expect(result.parentChildThreadCreatedEvent.payloadJson).toMatchObject({
      relation_type: "delegate",
      child_thread_id: result.thread.id,
      parent_thread_id: parentThreadId,
      target_agent_id: targetAgentId,
      invocation_id: parentInvocationId,
    });
  });

  it("contextTransferPolicyJson=null 且 budgetPolicyJson=null 时 relation 字段为 null", async () => {
    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });

    expect(result.relation.contextTransferPolicyJson).toBeNull();
    expect(result.relation.budgetPolicyJson).toBeNull();
    expect(result.relation.taskPayloadRef).toBeNull();
    expect(result.relation.taskPayloadHash).toBeNull();
  });

  it("幂等：同 idempotencyKey 重复调用 → 第二次因 UNIQUE 约束抛错（不静默返回）", async () => {
    const params = {
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
      idempotencyKey: "delegate-001",
    } as const;

    const first = await delegateChildThread(params);
    expect(first.thread.id).toBeDefined();

    // 第二次：父 Thread.lastEventSequence 已变化且 child_thread.created Event
    // 通过 idempotencyKey 关联；本阶段不在仓储层做幂等去重（由 Route 层 idempotency 中间件处理）
    // 期望抛错（UNIQUE(parent_thread_id, child_thread_id, relation_type) 由具体执行命中）
    await expect(delegateChildThread(params)).rejects.toThrow();
  });
});

// ─── delegateChildThread 错误路径 ─────────────────────────

describe("delegateChildThread 错误路径", () => {
  let tenantId: string;
  let ownerId: string;
  let parentAgentId: string;
  let targetAgentId: string;
  let otherTargetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    // targetAgentId 也发布允许自循环的 delegationPolicy（maxDepth=2）
    // 用于「委派深度超限」测试中二级和三级委派的 allowedTargets 校验
    const target = await seedAgentWithDelegationPolicy(tenantId, ownerId, "child-agent", {
      allowedTargets: [],
      maxDepth: 2,
    });
    targetAgentId = target.agentId;
    otherTargetAgentId = await seedEnabledAgent(tenantId, ownerId, "other-child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;
  });

  /** 为指定 Agent 发布新 Revision，更新 delegationPolicyJson。 */
  async function republishAgentDelegationPolicy(
    agentId: string,
    delegationPolicy: { allowedTargets: string[]; maxDepth?: number },
  ): Promise<void> {
    const agent = await getAgentById(tenantId, agentId);
    if (!agent) throw new Error(`Agent 不存在: ${agentId}`);
    const draft = await createDraftRevision({
      tenantId,
      agentId,
      sourceType: "agent_yaml",
      sourceRevision: `git_commit_${Date.now()}`,
      instructionHash: `sha256:instruction_${Date.now()}`,
      agentArtifactRef: "oci://registry/agent@sha256:abc",
      modelPolicyJson: { default: "doubao-pro" },
      permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
      delegationPolicyJson: delegationPolicy,
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: ["steer"] },
      createdBy: ownerId,
    });
    await publishRevision(tenantId, draft.id, agent.versionNo);
  }

  it("父 Invocation 非 running → ParentInvocationNotActiveError", async () => {
    // seedThreadWithRunningInvocation 已将 Invocation 从 queued → running；
    // 此处继续转为 completed（running → completed）
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, parentInvocationId, "completed");
    });

    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ParentInvocationNotActiveError);
  });

  it("target Agent 不在 allowedTargets → DelegationNotAllowedError", async () => {
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId: otherTargetAgentId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(DelegationNotAllowedError);
  });

  it("target Agent 跨租户不可见 → DelegationNotAllowedError", async () => {
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId: randomUUID(), // 不存在的 Agent
        actorId: ownerId,
      }),
    ).rejects.toThrow(DelegationNotAllowedError);
  });

  it("父 Thread 跨租户不可见 → ThreadNotFoundError", async () => {
    await expect(
      delegateChildThread({
        tenantId: "other-tenant-id",
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ThreadNotFoundError);
  });

  it("父 Thread 不存在 → ThreadNotFoundError", async () => {
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId: randomUUID(),
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ThreadNotFoundError);
  });

  it("budgetPolicyJson.maxTokens 为负 → ChildBudgetExceededError", async () => {
    const negativeBudget: DelegationBudgetPolicy = { maxTokens: -100 };
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        budgetPolicyJson: negativeBudget,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ChildBudgetExceededError);
  });

  it("budgetPolicyJson.maxWallClockMs 为负 → ChildBudgetExceededError", async () => {
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        budgetPolicyJson: { maxWallClockMs: -1 },
        actorId: ownerId,
      }),
    ).rejects.toThrow(ChildBudgetExceededError);
  });

  it("budgetPolicyJson.maxCost 为负 → ChildBudgetExceededError", async () => {
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        budgetPolicyJson: { maxCost: -0.5 },
        actorId: ownerId,
      }),
    ).rejects.toThrow(ChildBudgetExceededError);
  });

  it("contextTransferPolicyJson 含 sensitive Item → ChildContextNotAllowedError", async () => {
    // 在父 Thread 上插入一个 contextPolicy=sensitive 的 Item
    // 通过 acceptUserMessageTurn 创建的 user_message 默认 contextPolicy=include
    // 这里直接 DB 写入一个 sensitive Item
    const [parentThread] = await db.select().from(v11ThreadRelation).limit(1);

    // 通过 turn-queries 创建 user_message Item，然后更新为 sensitive
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId: parentThreadId,
      ownerUserId: ownerId,
      content: { text: "敏感内容" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });

    // 取出 triggerItemId 并改为 sensitive
    const [item] = await db
      .select()
      .from(v11ThreadItem)
      .where(eq(v11ThreadItem.turnId, turn.id))
      .limit(1);
    if (!item) throw new Error("测试前置：Item 未创建");

    await db
      .update(v11ThreadItem)
      .set({ contextPolicy: "sensitive" })
      .where(eq(v11ThreadItem.id, item.id));

    const badPolicy: ContextTransferPolicy = {
      mode: "selective",
      includeItemIds: [item.id],
    };

    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        contextTransferPolicyJson: badPolicy,
        actorId: ownerId,
      }),
    ).rejects.toThrow(ChildContextNotAllowedError);
  });

  it("委派深度超限 → DelegationDepthExceededError", async () => {
    // 为 targetAgentId 重发布允许自循环的 delegationPolicy（maxDepth=2）
    // 这样二级委派（depth=1+1=2）和三级委派（depth=2+1=3）的 allowedTargets 校验都能通过，
    // 三级委派时 maxDepth=2 被超出，抛 DelegationDepthExceededError
    await republishAgentDelegationPolicy(targetAgentId, {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });

    // 第一次委派（depth: 0 → 1，maxDepth=2 允许）
    const firstChild = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });

    // 在 child Thread 创建 running Invocation
    const { turn: childTurn } = await acceptUserMessageTurn({
      tenantId,
      threadId: firstChild.thread.id,
      ownerUserId: ownerId,
      content: { text: "二级委派" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation: childInvocation } = await createInvocation({
      tenantId,
      threadId: firstChild.thread.id,
      turnId: childTurn.id,
      invocationKind: "initial",
      triggerItemId: childTurn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, childInvocation.id, "running");
    });

    // 二级委派（child → grandchild）：depth 父=1，子=2，maxDepth=2，允许
    const secondChild = await delegateChildThread({
      tenantId,
      parentThreadId: firstChild.thread.id,
      ownerUserId: ownerId,
      parentInvocationId: childInvocation.id,
      targetAgentId, // 同一 Agent（自循环）
      actorId: ownerId,
    });

    // 三级委派（grandchild → great-grandchild）：depth 父=2，子=3，maxDepth=2，超限
    const { turn: grandTurn } = await acceptUserMessageTurn({
      tenantId,
      threadId: secondChild.thread.id,
      ownerUserId: ownerId,
      content: { text: "三级委派" } as unknown as Parameters<
        typeof acceptUserMessageTurn
      >[0]["content"],
      actorId: ownerId,
    });
    const { invocation: grandInvocation } = await createInvocation({
      tenantId,
      threadId: secondChild.thread.id,
      turnId: grandTurn.id,
      invocationKind: "initial",
      triggerItemId: grandTurn.triggerItemId,
      actorType: "system",
    });
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, tenantId, grandInvocation.id, "running");
    });

    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId: secondChild.thread.id,
        ownerUserId: ownerId,
        parentInvocationId: grandInvocation.id,
        targetAgentId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(DelegationDepthExceededError);
  });
});

// ─── 查询函数 ─────────────────────────────────────────────

describe("Child Thread 查询函数", () => {
  let tenantId: string;
  let ownerId: string;
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let relationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;

    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    relationId = result.relation.id;
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
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;

    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    relationId = result.relation.id;
    childThreadId = result.thread.id;
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
      .update(v11ThreadRelation)
      .set({ relationState: "completed", completedAt: new Date() })
      .where(eq(v11ThreadRelation.id, relationId));

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
      .update(v11ThreadRelation)
      .set({ relationState: "cancelled", completedAt: new Date() })
      .where(eq(v11ThreadRelation.id, relationId));

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

// ─── computeDelegationDepth ───────────────────────────────

describe("computeDelegationDepth 深度计算", () => {
  let tenantId: string;
  let ownerId: string;
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 3,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;
  });

  it("root Thread depth=0", async () => {
    const depth = await computeDelegationDepth(parentThreadId);
    expect(depth).toBe(0);
  });

  it("一级 delegate 子 Thread depth=1", async () => {
    const child = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    const depth = await computeDelegationDepth(child.thread.id);
    expect(depth).toBe(1);
  });

  it("不存在 Thread depth=0", async () => {
    const depth = await computeDelegationDepth(randomUUID());
    expect(depth).toBe(0);
  });
});

// ─── 集成不变量验证 ───────────────────────────────────────

describe("S09-C01 不变量验证", () => {
  let tenantId: string;
  let ownerId: string;
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;
  });

  it("子 Thread lifecycleState=active 且独立 Workspace（defaultWorkspaceId=null）", async () => {
    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    expect(result.thread.lifecycleState).toBe("active");
    expect(result.thread.defaultWorkspaceId).toBeNull();
  });

  it("子 Thread primaryAgentId=targetAgentId（不继承父 Agent）", async () => {
    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    expect(result.thread.primaryAgentId).toBe(targetAgentId);
    expect(result.thread.primaryAgentId).not.toBe(parentAgentId);
  });

  it("UNIQUE(parent_thread_id, child_thread_id, relation_type)：同 parent+child+type 重复抛错", async () => {
    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });

    // 直接 INSERT 同 parent+child+delegate 组合应失败
    await expect(
      db.insert(v11ThreadRelation).values({
        parentThreadId,
        childThreadId: result.thread.id,
        relationType: "delegate",
        relationState: "active",
      }),
    ).rejects.toThrow();
  });

  it("父 Thread lastEventSequence 在 delegateChildThread 后递增", async () => {
    const beforeThread = await db.select().from(v11ThreadRelation).limit(1);

    // 取父 Thread 当前 lastEventSequence
    const [parentBefore] = await db
      .select({ lastEventSequence: v11ThreadRelation.id })
      .from(v11ThreadRelation)
      .limit(1);

    // 直接查询 v11Thread 表
    const { v11Thread } = await import("@/lib/v11/schema/conversation");
    const [threadRow] = await db
      .select({ lastEventSequence: v11Thread.lastEventSequence })
      .from(v11Thread)
      .where(eq(v11Thread.id, parentThreadId))
      .limit(1);
    const before = threadRow?.lastEventSequence ?? 0;

    await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });

    const [threadAfter] = await db
      .select({ lastEventSequence: v11Thread.lastEventSequence })
      .from(v11Thread)
      .where(eq(v11Thread.id, parentThreadId))
      .limit(1);
    // S09-C02：delegateChildThread 同事务写两条父 Thread Event
    // （child_thread.created + item.created），lastEventSequence 递增 2
    expect(threadAfter?.lastEventSequence).toBe(before + 2);
  });

  it("Agent 当前 revision 的 delegationPolicyJson 决定委派能力", async () => {
    // 验证：通过修改父 Agent 的 published Revision 的 delegationPolicyJson
    // 注意：published Revision 不可改业务内容，所以这里通过发布新 Revision 实现
    // 但当前实现读取 Agent.currentRevisionId，新发布的 Revision 会回填到 currentRevisionId
    // 这里测试：发布新 Revision 把 targetAgentId 移除 allowedTargets 后，委派应失败
    const newTargetAgentId = await seedEnabledAgent(tenantId, ownerId, "new-child-agent");

    // 创建新 draft Revision，allowedTargets 不含原 targetAgentId
    const draft = await createDraftRevision({
      tenantId,
      agentId: parentAgentId,
      sourceType: "agent_yaml",
      sourceRevision: "git_commit_2",
      instructionHash: "sha256:instruction_2",
      agentArtifactRef: "oci://registry/agent@sha256:def",
      modelPolicyJson: { default: "doubao-pro" },
      permissionRequirementsJson: { tool_risk_max: "high_with_confirmation" },
      delegationPolicyJson: { allowedTargets: [newTargetAgentId], maxDepth: 2 },
      agentInterfaceRequirementsJson: { required: ["event_stream"], optional: ["steer"] },
      createdBy: ownerId,
    });

    // 取当前 Agent versionNo（用于乐观锁）
    const parentAgent = await getAgentById(tenantId, parentAgentId);
    expect(parentAgent).not.toBeNull();
    await publishRevision(tenantId, draft.id, parentAgent?.versionNo ?? 1);

    // 现在原 targetAgentId 已不在 allowedTargets，委派应失败
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId,
        actorId: ownerId,
      }),
    ).rejects.toThrow(DelegationNotAllowedError);

    // 新 targetAgentId 应成功
    await expect(
      delegateChildThread({
        tenantId,
        parentThreadId,
        ownerUserId: ownerId,
        parentInvocationId,
        targetAgentId: newTargetAgentId,
        actorId: ownerId,
      }),
    ).resolves.toBeDefined();
  });
});

// ─── S09-C02: projectChildThreadResult ────────────────────

/**
 * 在子 Thread 上创建 completed agent_message Item，模拟子 Thread 终态结果。
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

  // 3. 创建 agent_message Item（itemState=completed）
  const itemId = randomUUID();

  // 直接 INSERT 一个 completed agent_message Item
  const { v11Thread } = await import("@/lib/v11/schema/conversation");
  const [threadRow] = await db
    .select()
    .from(v11Thread)
    .where(eq(v11Thread.id, childThreadId))
    .limit(1);
  if (!threadRow) throw new Error("子 Thread 不存在");

  // 分配 itemSequence
  const itemSequence = threadRow.lastItemSequence + 1;
  await db
    .update(v11Thread)
    .set({ lastItemSequence: itemSequence })
    .where(eq(v11Thread.id, childThreadId));

  const contentJson = { text: messageText, agent_id: agentId };
  const contentHash = `sha256:${messageText}`;
  await db.insert(v11ThreadItem).values({
    id: itemId,
    threadId: childThreadId,
    turnId: turn.id,
    itemSequence,
    itemType: "agent_message",
    itemState: "completed",
    authorType: "agent",
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
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let relationId: string;
  let childThreadId: string;
  let childItemId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;

    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    relationId = result.relation.id;
    childThreadId = result.thread.id;

    // 在子 Thread 上创建 completed agent_message Item
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
      .update(v11ThreadRelation)
      .set({ relationState: "cancelled", completedAt: new Date() })
      .where(eq(v11ThreadRelation.id, relationId));

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
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;

    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    relationId = result.relation.id;
    childThreadId = result.thread.id;
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
      .update(v11ThreadRelation)
      .set({ relationState: "cancelled", completedAt: new Date() })
      .where(eq(v11ThreadRelation.id, relationId));

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
      .update(v11ThreadRelation)
      .set({ relationState: "completed", completedAt: new Date() })
      .where(eq(v11ThreadRelation.id, relationId));

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
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let relationId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;

    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      actorId: ownerId,
    });
    relationId = result.relation.id;
    childThreadId = result.thread.id;
  });

  it("completed 分派 → 调用 projectChildThreadResult", async () => {
    // 在子 Thread 上创建 completed agent_message Item + completed Invocation
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
      primaryAgentId: parentAgentId,
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
      .update(v11ThreadRelation)
      .set({ relationState: "completed", completedAt: new Date() })
      .where(eq(v11ThreadRelation.id, relationId));

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
  let parentAgentId: string;
  let targetAgentId: string;
  let parentThreadId: string;
  let parentInvocationId: string;
  let relationId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;

    targetAgentId = await seedEnabledAgent(tenantId, ownerId, "child-agent");
    const parent = await seedAgentWithDelegationPolicy(tenantId, ownerId, "parent-agent", {
      allowedTargets: [targetAgentId],
      maxDepth: 2,
    });
    parentAgentId = parent.agentId;

    const seed = await seedThreadWithRunningInvocation(tenantId, ownerId, parentAgentId);
    parentThreadId = seed.threadId;
    parentInvocationId = seed.invocationId;

    const result = await delegateChildThread({
      tenantId,
      parentThreadId,
      ownerUserId: ownerId,
      parentInvocationId,
      targetAgentId,
      budgetPolicyJson: { maxTokens: 1000, maxCost: 5, maxWallClockMs: 60000 },
      actorId: ownerId,
    });
    relationId = result.relation.id;
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
