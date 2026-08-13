import { createAgent } from "@/lib/agents/persistence/agent-queries";
import {
  GoalAlreadyActiveError,
  ItemSupersedeCycleError,
  ThreadNotAcceptingTurnsError,
  ThreadNotFoundError,
  ThreadRelationConflictError,
  ThreadVersionConflictError,
  TurnStateConflictError,
} from "@/lib/conversations/errors";
import {
  createGoal,
  getActiveGoalByThread,
  updateGoalState,
} from "@/lib/conversations/goal-queries";
import {
  getItemById,
  listItemsByThread,
  supersedeItem,
} from "@/lib/conversations/thread-item-queries";
import {
  changePrimaryAgent,
  createThread,
  getThreadById,
  listThreadsForUser,
  requireThread,
  updateThreadLifecycle,
  updateThreadSettings,
} from "@/lib/conversations/thread-queries";
import {
  createThreadRelation,
  getRelationsByChild,
  getRelationsByParent,
  updateRelationState,
} from "@/lib/conversations/thread-relation-queries";
import {
  acceptJobResultTurn,
  acceptUserMessageTurn,
  getTurnById,
  updateTurnState,
} from "@/lib/conversations/turn-queries";
/**
 * S04-C01：会话域集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - thread-queries：createThread/getThreadById/requireThread/listThreadsForUser/updateThreadLifecycle/updateThreadSettings/changePrimaryAgent。
 * - turn-queries：acceptUserMessageTurn/acceptJobResultTurn/getTurnById/updateTurnState。
 * - thread-item-queries：getItemById/listItemsByThread/supersedeItem。
 * - goal-queries：createGoal/getActiveGoalByThread/updateGoalState。
 * - thread-relation-queries：createThreadRelation/getRelationsByParent/getRelationsByChild/updateRelationState。
 * - 不变量：Thread lifecycle 单向流转；Turn 状态机；Item supersede 链无环；Goal 一 Thread 一 active。
 * - 乐观锁：Thread/Turn versionNo 不匹配抛冲突错误。
 * - 跨租户隔离：Thread/Turn/Item 查询按 tenantId 过滤。
 * - 错误类型：ThreadNotFoundError/ThreadNotAcceptingTurnsError/ThreadVersionConflictError/TurnStateConflictError/ItemSupersedeCycleError/GoalAlreadyActiveError/ThreadRelationConflictError。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
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

async function seedAgent(tenantId: string, ownerId: string) {
  return createAgent({
    tenantId,
    agentKey: "finance",
    displayName: "Finance Agent",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });
}

async function seedThread(tenantId: string, ownerId: string, agentId: string) {
  return createThread({
    tenantId,
    ownerUserId: ownerId,
    primaryAgentId: agentId,
    actorId: ownerId,
  });
}

// ─── Thread CRUD ─────────────────────────────────────────

describe("Thread CRUD", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
  });

  it("createThread 返回 thread + event，初始 lifecycle=active，event=thread.created(sequence=1)", async () => {
    const { thread, event } = await seedThread(tenantId, ownerId, agentId);

    expect(thread.tenantId).toBe(tenantId);
    expect(thread.ownerUserId).toBe(ownerId);
    expect(thread.primaryAgentId).toBe(agentId);
    expect(thread.lifecycleState).toBe("active");
    expect(thread.lastTurnSequence).toBe(0);
    expect(thread.lastItemSequence).toBe(0);
    expect(thread.lastEventSequence).toBe(1);
    expect(thread.versionNo).toBe(1);
    expect(thread.deletedAt).toBeNull();

    expect(event.threadId).toBe(thread.id);
    expect(event.eventType).toBe("thread.created");
    expect(event.eventSequence).toBe(1);
    expect(event.actorType).toBe("user");
    expect(event.actorId).toBe(ownerId);
  });

  it("getThreadById 存在时返回 Thread", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    const found = await getThreadById(tenantId, thread.id);
    expect(found?.id).toBe(thread.id);
    expect(found?.tenantId).toBe(tenantId);
  });

  it("getThreadById 不存在返回 null", async () => {
    expect(await getThreadById(tenantId, "missing-id")).toBeNull();
  });

  it("listThreadsForUser 按 lastActivityAt 降序", async () => {
    // 创建 Thread A
    const { thread: threadA } = await seedThread(tenantId, ownerId, agentId);
    // 创建 Thread B（lastActivityAt >= A）
    const { thread: threadB } = await seedThread(tenantId, ownerId, agentId);
    // 在 Thread A 上接纳 Turn，更新 lastActivityAt 为更晚的时间
    await acceptUserMessageTurn({
      tenantId,
      threadId: threadA.id,
      ownerUserId: ownerId,
      content: { text: "bump A activity" },
      actorId: ownerId,
    });

    const list = await listThreadsForUser(tenantId, ownerId);
    expect(list).toHaveLength(2);
    // A 最近活跃，应排第一
    expect(list[0]?.id).toBe(threadA.id);
    expect(list[1]?.id).toBe(threadB.id);
  });

  it("listThreadsForUser 默认不含 deleted", async () => {
    const { thread: threadA } = await seedThread(tenantId, ownerId, agentId);
    const { thread: threadB } = await seedThread(tenantId, ownerId, agentId);
    // 删除 A
    await updateThreadLifecycle(tenantId, threadA.id, "deleted", 1);

    const list = await listThreadsForUser(tenantId, ownerId);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(threadB.id);

    // includeDeleted=true 返回全部
    const all = await listThreadsForUser(tenantId, ownerId, { includeDeleted: true });
    expect(all).toHaveLength(2);
  });

  it("getThreadById 跨租户隔离：不同 tenantId 返回 null", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    expect(await getThreadById("other-tenant-id", thread.id)).toBeNull();
  });

  it("requireThread 不存在抛 ThreadNotFoundError", async () => {
    await expect(requireThread(tenantId, "missing-id")).rejects.toThrow(ThreadNotFoundError);
  });

  it("requireThread 存在时返回 Thread", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    const found = await requireThread(tenantId, thread.id);
    expect(found.id).toBe(thread.id);
  });
});

// ─── Thread lifecycle 状态机 ─────────────────────────────

describe("Thread lifecycle 状态机", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
  });

  it("active → archived 成功，versionNo 递增", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    const updated = await updateThreadLifecycle(tenantId, thread.id, "archived", 1);
    expect(updated?.lifecycleState).toBe("archived");
    expect(updated?.versionNo).toBe(2);
    expect(updated?.deletedAt).toBeNull();
  });

  it("archived → deleted 成功，deletedAt 设置", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    await updateThreadLifecycle(tenantId, thread.id, "archived", 1);
    const deleted = await updateThreadLifecycle(tenantId, thread.id, "deleted", 2);
    expect(deleted?.lifecycleState).toBe("deleted");
    expect(deleted?.versionNo).toBe(3);
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it("active → deleted 成功（跳过 archived）", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    const deleted = await updateThreadLifecycle(tenantId, thread.id, "deleted", 1);
    expect(deleted?.lifecycleState).toBe("deleted");
    expect(deleted?.versionNo).toBe(2);
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it("deleted → archived 抛 ThreadNotAcceptingTurnsError（非法转换）", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    await updateThreadLifecycle(tenantId, thread.id, "deleted", 1);
    await expect(updateThreadLifecycle(tenantId, thread.id, "archived", 2)).rejects.toThrow(
      ThreadNotAcceptingTurnsError,
    );
  });

  it("乐观锁冲突：versionNo 不匹配抛 ThreadVersionConflictError", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    await expect(updateThreadLifecycle(tenantId, thread.id, "archived", 999)).rejects.toThrow(
      ThreadVersionConflictError,
    );
  });
});

// ─── Thread 设置更新 ─────────────────────────────────────

describe("Thread 设置更新", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
  });

  it("updateThreadSettings 更新 defaultModelRef/defaultWorkspaceId，versionNo 递增", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    const updated = await updateThreadSettings(
      tenantId,
      thread.id,
      {
        defaultModelRef: "doubao-pro",
        defaultWorkspaceId: "ws-001",
      },
      1,
    );
    expect(updated?.defaultModelRef).toBe("doubao-pro");
    expect(updated?.defaultWorkspaceId).toBe("ws-001");
    expect(updated?.versionNo).toBe(2);
  });

  it("changePrimaryAgent 更新 primaryAgentId，versionNo 递增", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    // 创建另一个 Agent
    const otherAgent = await createAgent({
      tenantId,
      agentKey: "chart",
      displayName: "Chart Agent",
      ownerUserId: ownerId,
      lifecycleState: "enabled",
    });
    const updated = await changePrimaryAgent(tenantId, thread.id, otherAgent.id, 1);
    expect(updated?.primaryAgentId).toBe(otherAgent.id);
    expect(updated?.versionNo).toBe(2);
  });

  it("updateThreadSettings 乐观锁冲突抛 ThreadVersionConflictError", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    await expect(
      updateThreadSettings(tenantId, thread.id, { defaultModelRef: "x" }, 999),
    ).rejects.toThrow(ThreadVersionConflictError);
  });

  it("changePrimaryAgent 乐观锁冲突抛 ThreadVersionConflictError", async () => {
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    await expect(changePrimaryAgent(tenantId, thread.id, "other-agent", 999)).rejects.toThrow(
      ThreadVersionConflictError,
    );
  });
});

// ─── Turn 接纳事务 ───────────────────────────────────────

describe("Turn 接纳事务", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("acceptUserMessageTurn 返回 thread + turn + item + events，序列号正确", async () => {
    const result = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "你好" },
      actorId: ownerId,
    });

    // Turn 校验
    expect(result.turn.threadId).toBe(threadId);
    expect(result.turn.turnState).toBe("accepted");
    expect(result.turn.triggerType).toBe("user_message");
    expect(result.turn.triggerItemId).toBe(result.item.id);
    expect(result.turn.turnSequence).toBe(1);
    expect(result.turn.versionNo).toBe(1);

    // Item 校验
    expect(result.item.threadId).toBe(threadId);
    expect(result.item.itemType).toBe("user_message");
    expect(result.item.itemState).toBe("completed");
    expect(result.item.authorType).toBe("user");
    expect(result.item.authorId).toBe(ownerId);
    expect(result.item.itemSequence).toBe(1);

    // Events 校验：turn.accepted(seq=2) + item.created(seq=3)
    // 事件顺序：turn.accepted 先于 item.created，确保投影器按序消费时 Turn 行先创建
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.eventType).toBe("turn.accepted");
    expect(result.events[0]?.eventSequence).toBe(2);
    expect(result.events[0]?.turnId).toBe(result.turn.id);
    expect(result.events[1]?.eventType).toBe("item.created");
    expect(result.events[1]?.eventSequence).toBe(3);
    expect(result.events[1]?.itemId).toBe(result.item.id);
    expect(result.events[1]?.turnId).toBe(result.turn.id);

    // Thread 序列号基线：lastEventSequence=3（thread.created=1 + turn.accepted=2 + item.created=3）
    expect(result.thread.lastTurnSequence).toBe(1);
    expect(result.thread.lastItemSequence).toBe(1);
    expect(result.thread.lastEventSequence).toBe(3);
  });

  it("连续接纳多个 Turn：turn/item/event sequence 单调递增", async () => {
    const t1 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第一轮" },
      actorId: ownerId,
    });
    const t2 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第二轮" },
      actorId: ownerId,
    });
    const t3 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第三轮" },
      actorId: ownerId,
    });

    // turnSequence 单调递增
    expect(t1.turn.turnSequence).toBe(1);
    expect(t2.turn.turnSequence).toBe(2);
    expect(t3.turn.turnSequence).toBe(3);

    // itemSequence 单调递增
    expect(t1.item.itemSequence).toBe(1);
    expect(t2.item.itemSequence).toBe(2);
    expect(t3.item.itemSequence).toBe(3);

    // lastEventSequence 单调递增：1(thread.created) → 3 → 5 → 7
    expect(t1.thread.lastEventSequence).toBe(3);
    expect(t2.thread.lastEventSequence).toBe(5);
    expect(t3.thread.lastEventSequence).toBe(7);

    // 每轮 events 各 2 个，sequence 连续
    expect(t2.events[0]?.eventSequence).toBe(4);
    expect(t2.events[1]?.eventSequence).toBe(5);
    expect(t3.events[0]?.eventSequence).toBe(6);
    expect(t3.events[1]?.eventSequence).toBe(7);
  });

  it("archived Thread 不允许新 Turn：抛 ThreadNotAcceptingTurnsError", async () => {
    await updateThreadLifecycle(tenantId, threadId, "archived", 1);
    await expect(
      acceptUserMessageTurn({
        tenantId,
        threadId,
        ownerUserId: ownerId,
        content: { text: "不应接纳" },
        actorId: ownerId,
      }),
    ).rejects.toThrow(ThreadNotAcceptingTurnsError);
  });

  it("acceptJobResultTurn：turn.turnState = completed，triggerType = job_result_projection", async () => {
    const result = await acceptJobResultTurn({
      tenantId,
      threadId,
      triggerRef: "job:run-001",
      actorId: ownerId,
    });

    expect(result.turn.threadId).toBe(threadId);
    expect(result.turn.turnState).toBe("completed");
    expect(result.turn.triggerType).toBe("job_result_projection");
    expect(result.turn.triggerRef).toBe("job:run-001");
    expect(result.turn.turnSequence).toBe(1);
    expect(result.turn.finishedAt).not.toBeNull();

    // events：turn.accepted + turn.completed
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.eventType).toBe("turn.accepted");
    expect(result.events[1]?.eventType).toBe("turn.completed");
  });

  it("acceptUserMessageTurn 跨租户隔离：错误 tenantId 抛 ThreadNotFoundError", async () => {
    await expect(
      acceptUserMessageTurn({
        tenantId: "other-tenant-id",
        threadId,
        ownerUserId: ownerId,
        content: { text: "跨租户" },
        actorId: ownerId,
      }),
    ).rejects.toThrow(ThreadNotFoundError);
  });
});

// ─── Turn 状态机 ─────────────────────────────────────────

describe("Turn 状态机", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("accepted → queued → running → completed：成功，finishedAt 设置", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "开始" },
      actorId: ownerId,
    });

    const queued = await updateTurnState(tenantId, turn.id, "queued", 1);
    expect(queued?.turnState).toBe("queued");
    expect(queued?.versionNo).toBe(2);

    const running = await updateTurnState(tenantId, turn.id, "running", 2);
    expect(running?.turnState).toBe("running");
    expect(running?.versionNo).toBe(3);
    expect(running?.startedAt).not.toBeNull();

    const completed = await updateTurnState(tenantId, turn.id, "completed", 3);
    expect(completed?.turnState).toBe("completed");
    expect(completed?.versionNo).toBe(4);
    expect(completed?.finishedAt).not.toBeNull();
    expect(completed?.activeInvocationId).toBeNull();
  });

  it("running → waiting_user → running：成功，waitingAt 设置", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "等待" },
      actorId: ownerId,
    });
    await updateTurnState(tenantId, turn.id, "queued", 1);
    await updateTurnState(tenantId, turn.id, "running", 2);

    const waiting = await updateTurnState(tenantId, turn.id, "waiting_user", 3);
    expect(waiting?.turnState).toBe("waiting_user");
    expect(waiting?.versionNo).toBe(4);
    expect(waiting?.waitingAt).not.toBeNull();

    const running = await updateTurnState(tenantId, turn.id, "running", 4);
    expect(running?.turnState).toBe("running");
    expect(running?.versionNo).toBe(5);
  });

  it("running → interrupted：成功", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "中断" },
      actorId: ownerId,
    });
    await updateTurnState(tenantId, turn.id, "queued", 1);
    await updateTurnState(tenantId, turn.id, "running", 2);

    const interrupted = await updateTurnState(tenantId, turn.id, "interrupted", 3);
    expect(interrupted?.turnState).toBe("interrupted");
    expect(interrupted?.versionNo).toBe(4);
    expect(interrupted?.finishedAt).not.toBeNull();
  });

  it("cancelled 不可恢复：cancelled → queued 抛 TurnStateConflictError", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "取消" },
      actorId: ownerId,
    });
    // accepted → cancelled 允许
    const cancelled = await updateTurnState(tenantId, turn.id, "cancelled", 1);
    expect(cancelled?.turnState).toBe("cancelled");

    // cancelled → queued 非法
    await expect(updateTurnState(tenantId, turn.id, "queued", 2)).rejects.toThrow(
      TurnStateConflictError,
    );
  });

  it("乐观锁冲突：versionNo 不匹配抛 TurnStateConflictError", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "冲突" },
      actorId: ownerId,
    });
    await expect(updateTurnState(tenantId, turn.id, "queued", 999)).rejects.toThrow(
      TurnStateConflictError,
    );
  });

  it("getTurnById 跨租户隔离：返回 null", async () => {
    const { turn } = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "隔离" },
      actorId: ownerId,
    });
    expect(await getTurnById("other-tenant-id", turn.id)).toBeNull();
  });
});

// ─── Item 查询和 supersede ───────────────────────────────

describe("Item 查询和 supersede", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("listItemsByThread 默认不返回 superseded Item", async () => {
    // 接纳两个 Turn，产生两个 user_message Item
    const t1 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第一条" },
      actorId: ownerId,
    });
    const t2 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第二条" },
      actorId: ownerId,
    });
    // supersede 第一个 Item
    await supersedeItem(tenantId, t1.item.id, t2.item.id);

    const list = await listItemsByThread(tenantId, threadId);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(t2.item.id);
    expect(list[0]?.itemState).toBe("completed");
  });

  it("listItemsByThread includeSuperseded=true 返回所有 Item", async () => {
    const t1 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第一条" },
      actorId: ownerId,
    });
    const t2 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第二条" },
      actorId: ownerId,
    });
    await supersedeItem(tenantId, t1.item.id, t2.item.id);

    const list = await listItemsByThread(tenantId, threadId, { includeSuperseded: true });
    expect(list).toHaveLength(2);
    // 按 itemSequence 升序
    expect(list[0]?.id).toBe(t1.item.id);
    expect(list[0]?.itemState).toBe("superseded");
    expect(list[1]?.id).toBe(t2.item.id);
  });

  it("supersedeItem：旧 Item itemState = superseded，supersededByItemId 指向新 Item", async () => {
    const t1 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "旧" },
      actorId: ownerId,
    });
    const t2 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "新" },
      actorId: ownerId,
    });

    const superseded = await supersedeItem(tenantId, t1.item.id, t2.item.id);
    expect(superseded?.itemState).toBe("superseded");
    expect(superseded?.supersededByItemId).toBe(t2.item.id);

    // 通过 getItemById 再次确认
    const item = await getItemById(tenantId, t1.item.id);
    expect(item?.itemState).toBe("superseded");
    expect(item?.supersededByItemId).toBe(t2.item.id);
  });

  it("supersedeItem 环检测：oldItemId === newItemId 抛 ItemSupersedeCycleError", async () => {
    const t1 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "自引用" },
      actorId: ownerId,
    });
    await expect(supersedeItem(tenantId, t1.item.id, t1.item.id)).rejects.toThrow(
      ItemSupersedeCycleError,
    );
  });

  it("getItemById 跨租户隔离：返回 null", async () => {
    const t1 = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "隔离" },
      actorId: ownerId,
    });
    expect(await getItemById("other-tenant-id", t1.item.id)).toBeNull();
  });
});

// ─── Goal ────────────────────────────────────────────────

describe("Goal", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
    const { thread } = await seedThread(tenantId, ownerId, agentId);
    threadId = thread.id;
  });

  it("createGoal 返回 active Goal", async () => {
    const goal = await createGoal({
      threadId,
      objective: "完成月报",
      successCriteriaJson: { type: "manual_review" },
      createdBy: ownerId,
    });
    expect(goal.threadId).toBe(threadId);
    expect(goal.objective).toBe("完成月报");
    expect(goal.goalState).toBe("active");
    expect(goal.createdBy).toBe(ownerId);
    expect(goal.completedAt).toBeNull();
  });

  it("一个 Thread 最多一个 active：第二个 createGoal 抛 GoalAlreadyActiveError", async () => {
    await createGoal({
      threadId,
      objective: "目标一",
      successCriteriaJson: { type: "manual_review" },
      createdBy: ownerId,
    });
    await expect(
      createGoal({
        threadId,
        objective: "目标二",
        successCriteriaJson: { type: "manual_review" },
        createdBy: ownerId,
      }),
    ).rejects.toThrow(GoalAlreadyActiveError);
  });

  it("updateGoalState：active → completed，completedAt 设置", async () => {
    const goal = await createGoal({
      threadId,
      objective: "完成",
      successCriteriaJson: { type: "manual_review" },
      createdBy: ownerId,
    });
    const completed = await updateGoalState(goal.id, "completed");
    expect(completed?.goalState).toBe("completed");
    expect(completed?.completedAt).not.toBeNull();
  });

  it("updateGoalState：completed → active 抛 Error（终态不可恢复）", async () => {
    const goal = await createGoal({
      threadId,
      objective: "终态",
      successCriteriaJson: { type: "manual_review" },
      createdBy: ownerId,
    });
    await updateGoalState(goal.id, "completed");
    await expect(updateGoalState(goal.id, "active")).rejects.toThrow();
  });

  it("getActiveGoalByThread：completed 后返回 null", async () => {
    const goal = await createGoal({
      threadId,
      objective: "查询",
      successCriteriaJson: { type: "manual_review" },
      createdBy: ownerId,
    });
    const activeGoal = await getActiveGoalByThread(threadId);
    expect(activeGoal?.id).toBe(goal.id);

    await updateGoalState(goal.id, "completed");
    expect(await getActiveGoalByThread(threadId)).toBeNull();
  });
});

// ─── ThreadRelation ──────────────────────────────────────

describe("ThreadRelation", () => {
  let tenantId: string;
  let ownerId: string;
  let agentId: string;
  let parentThreadId: string;
  let childThreadId: string;

  beforeEach(async () => {
    const ctx = await seedTenantAndOwner();
    tenantId = ctx.tenantId;
    ownerId = ctx.ownerId;
    const agent = await seedAgent(tenantId, ownerId);
    agentId = agent.id;
    const { thread: parent } = await seedThread(tenantId, ownerId, agentId);
    const { thread: child } = await seedThread(tenantId, ownerId, agentId);
    parentThreadId = parent.id;
    childThreadId = child.id;
  });

  it("createThreadRelation 成功", async () => {
    const relation = await createThreadRelation({
      parentThreadId,
      childThreadId,
      relationType: "delegate",
      targetAgentId: agentId,
    });
    expect(relation.parentThreadId).toBe(parentThreadId);
    expect(relation.childThreadId).toBe(childThreadId);
    expect(relation.relationType).toBe("delegate");
    expect(relation.relationState).toBe("creating");
    expect(relation.targetAgentId).toBe(agentId);
  });

  it("parent === child 抛 Error", async () => {
    await expect(
      createThreadRelation({
        parentThreadId,
        childThreadId: parentThreadId,
        relationType: "delegate",
      }),
    ).rejects.toThrow();
  });

  it("重复创建抛 ThreadRelationConflictError", async () => {
    await createThreadRelation({
      parentThreadId,
      childThreadId,
      relationType: "delegate",
    });
    await expect(
      createThreadRelation({
        parentThreadId,
        childThreadId,
        relationType: "delegate",
      }),
    ).rejects.toThrow(ThreadRelationConflictError);
  });

  it("updateRelationState：creating → active → completed", async () => {
    const relation = await createThreadRelation({
      parentThreadId,
      childThreadId,
      relationType: "delegate",
    });
    const active = await updateRelationState(relation.id, "active");
    expect(active?.relationState).toBe("active");

    const completed = await updateRelationState(relation.id, "completed");
    expect(completed?.relationState).toBe("completed");
    expect(completed?.completedAt).not.toBeNull();
  });

  it("getRelationsByParent/getRelationsByChild 返回对应关系", async () => {
    await createThreadRelation({
      parentThreadId,
      childThreadId,
      relationType: "delegate",
    });

    const byParent = await getRelationsByParent(parentThreadId);
    expect(byParent).toHaveLength(1);
    expect(byParent[0]?.parentThreadId).toBe(parentThreadId);
    expect(byParent[0]?.childThreadId).toBe(childThreadId);

    const byChild = await getRelationsByChild(childThreadId);
    expect(byChild).toHaveLength(1);
    expect(byChild[0]?.parentThreadId).toBe(parentThreadId);
    expect(byChild[0]?.childThreadId).toBe(childThreadId);
  });
});
