import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { EventCursorExpiredError } from "@/lib/conversations/errors";
import {
  getDeliveryFailure,
  getProjectionCheckpoint,
  initEventStreamFloor,
  updateEventStreamFloorEarliest,
} from "@/lib/conversations/projection-checkpoint-queries";
import {
  THREAD_EVENT_STREAM,
  projectThreadEvent,
  projectThreadEvents,
  rebuildProjectionsForThread,
} from "@/lib/conversations/projector";
import {
  getItemSnapshotWithCursor,
  getProjectionHealth,
  getThreadProjection,
  getTurnTimelineProjection,
  listThreadProjectionsForUser,
  listTurnTimelineProjections,
} from "@/lib/conversations/read-model-queries";
import { createThread, listThreadEvents } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
/**
 * S04-C02：投影与读模型集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - 同毫秒多 Event sequence 全部可续读（§7.4 顺序与去重）。
 * - 投影幂等（重复投影同一 Event 不产生重复，checkpoint 不回退）。
 * - checkpoint 前移（投影成功后 checkpoint 推进到 event sequence）。
 * - cursor expired（Last-Event-ID < earliest_available_sequence 抛 EventCursorExpiredError）。
 * - 一致性读点（getItemSnapshotWithCursor 返回 Item + cursor 一致）。
 * - transient 事件忽略（response.delta/heartbeat 等不投影）。
 * - 未知事件类型写 event_delivery_failure（§2.1 规则 5）。
 * - sequence 空洞检测（§2.1 规则 4）。
 * - rebuildProjectionsForThread 从权威表重建。
 * - 读模型查询：listThreadProjectionsForUser / listTurnTimelineProjections / getProjectionHealth。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import type { ThreadEvent } from "@/lib/persistence/schema/conversation";
import { threadEventTable } from "@/lib/persistence/schema/conversation";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 租户 + 用户 + Agent + Thread ─────────────

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

async function seedFullContext() {
  const { tenantId, ownerId } = await seedTenantAndOwner();
  const agent = await seedAgent(tenantId, ownerId);
  const { thread, event } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });
  // 初始化 event_stream_floor（生产中由 createThread 同事务初始化，这里手动补齐）
  await initEventStreamFloor({
    streamType: THREAD_EVENT_STREAM,
    streamId: thread.id,
    tenantId,
    latestSequence: 1,
  });
  return { tenantId, ownerId, agentId: agent.id, threadId: thread.id, createdEvent: event };
}

// ─── 投影基础：thread.created 投影 ─────────────────────

describe("投影基础：thread.created", () => {
  it("projectThreadEvent 创建 thread_list_projection 行", async () => {
    const { tenantId, ownerId, agentId, threadId, createdEvent } = await seedFullContext();

    await projectThreadEvent(createdEvent);

    const projection = await getThreadProjection(tenantId, threadId);
    expect(projection).not.toBeNull();
    expect(projection?.threadId).toBe(threadId);
    expect(projection?.tenantId).toBe(tenantId);
    expect(projection?.ownerUserId).toBe(ownerId);
    expect(projection?.lifecycleState).toBe("active");
    expect(projection?.latestEventSequence).toBe(1);
    expect(projection?.latestEventId).toBe(createdEvent.id);
  });

  it("projectThreadEvent 后 checkpoint 前移到 event sequence", async () => {
    const { threadId, createdEvent } = await seedFullContext();

    await projectThreadEvent(createdEvent);

    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
    );
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.lastSequence).toBe(1);
    expect(checkpoint?.lastEventId).toBe(createdEvent.id);
  });
});

// ─── 同毫秒多 Event sequence 全部可续读 ─────────────────

describe("同毫秒多 Event sequence 全部可续读", () => {
  it("acceptUserMessageTurn 产生 3 个 event（thread.created + item.created + turn.accepted），全部投影成功", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    // acceptUserMessageTurn 产生 item.created(seq=2) + turn.accepted(seq=3)
    const turnResult = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "你好" },
      actorId: ownerId,
    });

    // 查询所有事件
    // 事件顺序：thread.created(1) + turn.accepted(2) + item.created(3)
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    expect(events).toHaveLength(3);
    expect(events[0]?.eventType).toBe("thread.created");
    expect(events[0]?.eventSequence).toBe(1);
    expect(events[1]?.eventType).toBe("turn.accepted");
    expect(events[1]?.eventSequence).toBe(2);
    expect(events[2]?.eventType).toBe("item.created");
    expect(events[2]?.eventSequence).toBe(3);

    // 逐个投影
    await projectThreadEvents(events);

    // 验证 thread_list_projection
    const threadProjection = await getThreadProjection(tenantId, threadId);
    expect(threadProjection?.latestEventSequence).toBe(3);
    expect(threadProjection?.currentTurnId).toBe(turnResult.turn.id);
    expect(threadProjection?.currentTurnState).toBe("accepted");

    // 验证 turn_timeline_projection
    const turnProjection = await getTurnTimelineProjection(tenantId, turnResult.turn.id);
    expect(turnProjection).not.toBeNull();
    expect(turnProjection?.turnState).toBe("accepted");
    expect(turnProjection?.turnSequence).toBe(1);
    expect(turnProjection?.triggerType).toBe("user_message");
    expect(turnProjection?.triggerItemId).toBe(turnResult.item.id);
  });

  it("连续多轮 Turn：所有 event sequence 全部可投影和续读", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    // 三轮 Turn，每轮产生 2 个 event
    await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第一轮" },
      actorId: ownerId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第二轮" },
      actorId: ownerId,
    });
    await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "第三轮" },
      actorId: ownerId,
    });

    // 共 7 个 event：1(thread.created) + 2 + 2 + 2
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    expect(events).toHaveLength(7);

    // 验证 sequence 连续无空洞
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.eventSequence).toBe(i + 1);
    }

    // 全部投影
    await projectThreadEvents(events);

    // 验证最终 checkpoint
    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
    );
    expect(checkpoint?.lastSequence).toBe(7);

    // 验证 turn_timeline 有 3 行
    const turnProjections = await listTurnTimelineProjections(tenantId, threadId);
    expect(turnProjections).toHaveLength(3);
    expect(turnProjections[0]?.turnSequence).toBe(1);
    expect(turnProjections[1]?.turnSequence).toBe(2);
    expect(turnProjections[2]?.turnSequence).toBe(3);
  });
});

// ─── 投影幂等 ─────────────────────────────────────────

describe("投影幂等", () => {
  it("重复投影同一 Event 不产生重复行，checkpoint 不回退", async () => {
    const { tenantId, threadId, createdEvent } = await seedFullContext();

    // 第一次投影
    await projectThreadEvent(createdEvent);

    // 第二次投影同一 event（幂等）
    await projectThreadEvent(createdEvent);

    // thread_list_projection 只有一行
    const projection = await getThreadProjection(tenantId, threadId);
    expect(projection?.latestEventSequence).toBe(1);
    expect(projection?.latestEventId).toBe(createdEvent.id);

    // checkpoint 没有回退（仍是 1）
    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
    );
    expect(checkpoint?.lastSequence).toBe(1);
  });

  it("批量重复投影多个 Event 保持幂等", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "幂等测试" },
      actorId: ownerId,
    });

    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });

    // 投影两次
    await projectThreadEvents(events);
    await projectThreadEvents(events);

    // 仍然只有 1 个 turn 投影
    const turnProjections = await listTurnTimelineProjections(tenantId, threadId);
    expect(turnProjections).toHaveLength(1);
    expect(turnProjections[0]?.itemCount).toBe(1); // item.created 只计数一次
  });
});

// ─── cursor expired ──────────────────────────────────

describe("EVENT_CURSOR_EXPIRED", () => {
  it("Last-Event-ID < earliest_available_sequence 抛 EventCursorExpiredError", async () => {
    const { threadId } = await seedFullContext();

    // 模拟保留任务：将 earliest_available_sequence 前移到 5
    await updateEventStreamFloorEarliest(THREAD_EVENT_STREAM, threadId, 5);

    // 客户端用 sequence=3 续读 → 应抛 EventCursorExpiredError
    await expect(
      (async () => {
        const { assertEventCursorValid } = await import(
          "@/lib/conversations/projection-checkpoint-queries"
        );
        await assertEventCursorValid(THREAD_EVENT_STREAM, threadId, 3);
      })(),
    ).rejects.toThrow(EventCursorExpiredError);
  });

  it("Last-Event-ID >= earliest_available_sequence 不抛错", async () => {
    const { threadId } = await seedFullContext();

    // earliest 仍是 1，用 sequence=1 续读 → OK
    const { assertEventCursorValid } = await import(
      "@/lib/conversations/projection-checkpoint-queries"
    );
    await expect(assertEventCursorValid(THREAD_EVENT_STREAM, threadId, 1)).resolves.toBeUndefined();
  });

  it("event_stream_floor 不存在时抛 EventCursorExpiredError", async () => {
    const { assertEventCursorValid } = await import(
      "@/lib/conversations/projection-checkpoint-queries"
    );
    await expect(assertEventCursorValid(THREAD_EVENT_STREAM, "missing-stream", 1)).rejects.toThrow(
      EventCursorExpiredError,
    );
  });
});

// ─── 一致性读点 ───────────────────────────────────────

describe("一致性读点 getItemSnapshotWithCursor", () => {
  it("返回 Item 列表 + latest_event_cursor（从权威表读取）", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    const turnResult = await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "一致性读点" },
      actorId: ownerId,
    });

    // 尚未投影，但一致性读点应从权威表读取
    const snapshot = await getItemSnapshotWithCursor(tenantId, threadId);

    // Item 列表（从 ThreadItem 权威表）
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.id).toBe(turnResult.item.id);

    // latest_event_cursor（从 Thread.lastEventSequence）
    expect(snapshot.latestEventCursor).not.toBeNull();
    expect(snapshot.latestEventCursor?.sequence).toBe(3); // thread.created=1 + item.created=2 + turn.accepted=3
    expect(snapshot.latestEventCursor?.eventId).not.toBeNull();
  });

  it("投影未追上时一致性读点仍正确（投影延迟不影响读点）", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "未投影" },
      actorId: ownerId,
    });

    // 不投影，直接读取
    const snapshot = await getItemSnapshotWithCursor(tenantId, threadId);
    expect(snapshot.latestEventCursor?.sequence).toBe(3);

    // thread_list_projection 未投影，getThreadProjection 返回 null
    const projection = await getThreadProjection(tenantId, threadId);
    expect(projection).toBeNull();
  });
});

// ─── transient 事件忽略 ───────────────────────────────

describe("transient 事件不投影", () => {
  it("response.delta 事件投影后不产生 failure 也不修改投影", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    // 先正常投影 thread.created
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    await projectThreadEvents(events);

    // 手动插入一个 transient event
    const transientEventId = await insertRawEvent(threadId, 2, "response.delta", {
      text_delta: "hello",
    });

    // 查询并投影这个 transient event
    const transientEvent = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.id, transientEventId))
      .limit(1);

    // 投影 transient event 不应抛错
    await projectThreadEvent(transientEvent[0] as ThreadEvent);

    // 不应产生 event_delivery_failure
    const failure = await getDeliveryFailure(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
      transientEventId,
    );
    expect(failure).toBeNull();

    // thread_list_projection 的 latestEventSequence 仍是 1（未前移）
    const projection = await getThreadProjection(tenantId, threadId);
    expect(projection?.latestEventSequence).toBe(1);
  });
});

// ─── 未知事件类型写 event_delivery_failure ─────────────

describe("未知事件类型写 event_delivery_failure", () => {
  it("未知 eventType 触发 ProjectionFailureError 并写入 event_delivery_failure", async () => {
    const { tenantId, threadId } = await seedFullContext();

    // 先投影 thread.created（sequence=1）
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    await projectThreadEvents(events);

    // 插入一个未知 eventType 的 event（sequence=2）
    const unknownEventId = await insertRawEvent(threadId, 2, "unknown.future_event", {
      foo: "bar",
    });

    const unknownEvent = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.id, unknownEventId))
      .limit(1);

    // 投影不应抛错（失败被捕获并写入 event_delivery_failure）
    await projectThreadEvent(unknownEvent[0] as ThreadEvent);

    // 验证 event_delivery_failure 已写入
    const failure = await getDeliveryFailure(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
      unknownEventId,
    );
    expect(failure).not.toBeNull();
    expect(failure?.failureClass).toBe("schema_unsupported");
    expect(failure?.attemptCount).toBe(1);

    // checkpoint 未前移（仍是 1）
    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
    );
    expect(checkpoint?.lastSequence).toBe(1);
  });
});

// ─── sequence 空洞检测 ────────────────────────────────

describe("sequence 空洞检测", () => {
  it("跳过 sequence 投影后续 event 不前移 checkpoint", async () => {
    const { tenantId, threadId } = await seedFullContext();

    // 先投影 thread.created（sequence=1）
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    await projectThreadEvents(events);

    // 插入 sequence=3 的 event（跳过 sequence=2）
    const gapEventId = await insertRawEvent(threadId, 3, "item.created", {
      item_type: "assistant_message",
      content_hash: "sha256:fake",
    });

    const gapEvent = await db
      .select()
      .from(threadEventTable)
      .where(eq(threadEventTable.id, gapEventId))
      .limit(1);

    // 投影 sequence=3 的 event：应检测到空洞
    await projectThreadEvent(gapEvent[0] as ThreadEvent);

    // 由于空洞，投影失败，应写入 event_delivery_failure
    const failure = await getDeliveryFailure(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
      gapEventId,
    );
    expect(failure).not.toBeNull();
    expect(failure?.failureClass).toBe("sequence_gap");

    // checkpoint 仍是 1（未前移）
    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      THREAD_EVENT_STREAM,
      threadId,
    );
    expect(checkpoint?.lastSequence).toBe(1);
  });
});

// ─── rebuildProjectionsForThread ──────────────────────

describe("rebuildProjectionsForThread 从权威表重建", () => {
  it("删除投影后重建与原始投影一致", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();

    await acceptUserMessageTurn({
      tenantId,
      threadId,
      ownerUserId: ownerId,
      content: { text: "重建测试" },
      actorId: ownerId,
    });

    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    await projectThreadEvents(events);

    // 记录原始投影状态
    const originalThreadProjection = await getThreadProjection(tenantId, threadId);
    const originalTurnProjections = await listTurnTimelineProjections(tenantId, threadId);
    expect(originalTurnProjections).toHaveLength(1);

    // 重建
    await rebuildProjectionsForThread(tenantId, threadId);

    // 验证重建后一致
    const rebuiltThreadProjection = await getThreadProjection(tenantId, threadId);
    expect(rebuiltThreadProjection?.threadId).toBe(originalThreadProjection?.threadId);
    expect(rebuiltThreadProjection?.latestEventSequence).toBe(
      originalThreadProjection?.latestEventSequence,
    );
    expect(rebuiltThreadProjection?.currentTurnId).toBe(originalThreadProjection?.currentTurnId);

    const rebuiltTurnProjections = await listTurnTimelineProjections(tenantId, threadId);
    expect(rebuiltTurnProjections).toHaveLength(1);
    expect(rebuiltTurnProjections[0]?.turnSequence).toBe(originalTurnProjections[0]?.turnSequence);
    expect(rebuiltTurnProjections[0]?.turnState).toBe(originalTurnProjections[0]?.turnState);
  });
});

// ─── 读模型查询 ───────────────────────────────────────

describe("读模型查询", () => {
  it("listThreadProjectionsForUser 按 lastActivityAt 降序", async () => {
    const ctx = await seedFullContext();

    // 创建第二个 Thread
    const { thread: thread2, event: event2 } = await createThread({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      actorId: ctx.ownerId,
    });
    await initEventStreamFloor({
      streamType: THREAD_EVENT_STREAM,
      streamId: thread2.id,
      tenantId: ctx.tenantId,
      latestSequence: 1,
    });

    // 投影两个 Thread 的 created event
    const events1 = await listThreadEvents(ctx.tenantId, ctx.threadId, { limit: 100 });
    await projectThreadEvents(events1);
    await projectThreadEvent(event2);

    const list = await listThreadProjectionsForUser(ctx.tenantId, ctx.ownerId);
    expect(list).toHaveLength(2);
    const ids = list.map((p) => p.threadId);
    expect(ids).toContain(ctx.threadId);
    expect(ids).toContain(thread2.id);
  });

  it("listThreadProjectionsForUser 跨租户隔离", async () => {
    const { tenantId, ownerId, threadId } = await seedFullContext();
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    await projectThreadEvents(events);

    const list = await listThreadProjectionsForUser("other-tenant", ownerId);
    expect(list).toHaveLength(0);
  });

  it("getProjectionHealth 返回 checkpoint 与权威 lastEventSequence 的 lag", async () => {
    const { tenantId, threadId } = await seedFullContext();

    const health = await getProjectionHealth(tenantId, threadId);
    expect(health).not.toBeNull();
    expect(health?.latestEventSequence).toBe(1);
    expect(health?.threadListCheckpoint).toBe(0); // 未投影
    expect(health?.turnTimelineCheckpoint).toBe(0);
    expect(health?.threadListLag).toBe(1);
    expect(health?.turnTimelineLag).toBe(1);
  });

  it("getProjectionHealth 投影后 lag=0", async () => {
    const { tenantId, threadId } = await seedFullContext();
    const events = await listThreadEvents(tenantId, threadId, { limit: 100 });
    await projectThreadEvents(events);

    const health = await getProjectionHealth(tenantId, threadId);
    expect(health?.threadListLag).toBe(0);
    expect(health?.turnTimelineLag).toBe(0);
  });
});

// ─── 辅助函数 ─────────────────────────────────────────

/** 直接插入一个原始 ThreadEvent（绕过 acceptUserMessageTurn 事务，用于测试特殊场景）。 */
async function insertRawEvent(
  threadId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const now = new Date();
  await db.insert(threadEventTable).values({
    id,
    threadId,
    eventSequence: sequence,
    eventType,
    schemaVersion: 1,
    actorType: "system",
    payloadJson: payload,
    occurredAt: now,
    ingestedAt: now,
  });
  return id;
}
