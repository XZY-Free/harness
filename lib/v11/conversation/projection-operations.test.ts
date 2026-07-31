import { randomUUID } from "node:crypto";
/**
 * S12-W01：V11 事件投影运维操作集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - quarantineIfExceeded：attemptCount 达到阈值自动隔离 / 未达到不隔离 / 非 retrying 不隔离
 * - resolveQuarantine：replay 重放事件 / skip 前移 checkpoint / 非 quarantined 拒绝 / 不存在抛错
 * - listDeliveryFailures：多维过滤 + 租户隔离
 * - getDeliveryFailureById：租户隔离（跨租户返回 null）
 * - getProjectionLagForStream：lag 计算 + quarantine 标记 + 跨租户空数组
 * - listQuarantinedFailures：仅 quarantined + 租户隔离
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createAgent } from "@/lib/v11/control-plane/agent-queries";
import {
  getProjectionCheckpoint,
  initEventStreamFloor,
  recordDeliveryFailure,
  updateDeliveryFailureState,
  updateEventStreamFloorLatest,
} from "@/lib/v11/conversation/projection-checkpoint-queries";
import {
  QUARANTINE_THRESHOLD,
  getDeliveryFailureById,
  getProjectionLagForStream,
  listDeliveryFailures,
  listQuarantinedFailures,
  quarantineIfExceeded,
  resolveQuarantine,
} from "@/lib/v11/conversation/projection-operations";
import { projectThreadEvent } from "@/lib/v11/conversation/projector";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { listAuditEvents } from "@/lib/v11/identity/audit-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { v11ThreadEvent } from "@/lib/v11/schema/conversation";
import { tenant } from "@/lib/v11/schema/identity";
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
  const tenantRow = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenantRow.id,
    externalSubject: "owner-001",
    email: "owner001@example.com",
    displayName: "Thread Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenantRow.id,
    subjectType: "user",
    externalId: "owner-001",
    displayName: "Thread Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenantRow.id, ownerId: identity.id };
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
    primaryAgentId: agent.id,
    actorId: ownerId,
  });
  await initEventStreamFloor({
    streamType: "thread_event",
    streamId: thread.id,
    tenantId,
    latestSequence: 1,
  });
  return { tenantId, ownerId, agentId: agent.id, threadId: thread.id, createdEvent: event };
}

/** 插入原始事件（绕过 createThread 的事件发布，直接写 v11ThreadEvent）。 */
async function insertRawEvent(
  threadId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(v11ThreadEvent).values({
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

/** 创建第二个租户（用于租户隔离测试）。 */
async function seedSecondTenant(): Promise<string> {
  const id = randomUUID();
  await db.insert(tenant).values({
    id,
    key: `tenant-${id.slice(0, 8)}`,
    name: `Test Tenant ${id.slice(0, 8)}`,
    status: "active",
  });
  return id;
}

/** 构造测试用 AuditActor。 */
function systemActor(tenantId: string) {
  return { tenantId, actorType: "system" as const, actorId: "test-projection-ops" };
}

// ─── quarantineIfExceeded ─────────────────────────────

describe("quarantineIfExceeded", () => {
  it("attemptCount 未达阈值时不隔离，返回 null", async () => {
    const { tenantId, threadId } = await seedFullContext();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
      lastErrorCode: "UNKNOWN",
    });

    // attemptCount = 1，未达阈值 5
    const result = await quarantineIfExceeded(failure.id);
    expect(result).toBeNull();

    // 状态应仍为 retrying
    const stillFailure = await getDeliveryFailureById(tenantId, failure.id);
    expect(stillFailure?.failureState).toBe("retrying");
  });

  it("attemptCount 达到阈值时自动隔离", async () => {
    const { tenantId, threadId } = await seedFullContext();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });

    // 手动设置 attemptCount = 阈值
    await updateDeliveryFailureState(failure.id, "retrying", {
      attemptCount: QUARANTINE_THRESHOLD,
    });

    const result = await quarantineIfExceeded(failure.id);
    expect(result).not.toBeNull();
    expect(result?.failureState).toBe("quarantined");
    expect(result?.nextRetryAt).toBeNull();
  });

  it("非 retrying 状态不隔离", async () => {
    const { threadId } = await seedFullContext();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });

    // 先隔离，再尝试 quarantineIfExceeded（不会重复操作）
    await updateDeliveryFailureState(failure.id, "quarantined", {
      attemptCount: QUARANTINE_THRESHOLD,
    });

    const result = await quarantineIfExceeded(failure.id);
    expect(result).toBeNull();
  });

  it("不存在的 failure 返回 null", async () => {
    const result = await quarantineIfExceeded(randomUUID());
    expect(result).toBeNull();
  });
});

// ─── resolveQuarantine ────────────────────────────────

describe("resolveQuarantine", () => {
  it("skip：前移 checkpoint 并标记 resolved", async () => {
    const { tenantId, threadId, createdEvent } = await seedFullContext();

    // 先投影 thread.created（seq 1），使 checkpoint 到 1
    await projectThreadEvent(createdEvent);

    // 创建一个 quarantined failure（seq 2）
    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await updateDeliveryFailureState(failure.id, "quarantined", {
      attemptCount: QUARANTINE_THRESHOLD,
    });

    // skip 处置
    const result = await resolveQuarantine({
      failureId: failure.id,
      resolution: "skip",
      actor: systemActor(tenantId),
      reason: "poison event 跳过",
    });

    expect(result.resolution).toBe("skip");
    expect(result.replayedCount).toBe(0);
    expect(result.failure.failureState).toBe("resolved");
    expect(result.failure.resolvedAt).not.toBeNull();

    // checkpoint 应前移到 seq 2
    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      "thread_event",
      threadId,
    );
    expect(checkpoint?.lastSequence).toBe(2);
    expect(checkpoint?.lastEventId).toBe(failure.eventId);

    // 验证审计事件
    const audits = await listAuditEvents({ tenantId, limit: 10 });
    const resolveAudit = audits.find((a) => a.actionType === "event.quarantine.resolve");
    expect(resolveAudit).toBeDefined();
    expect(resolveAudit?.targetId).toBe(failure.id);
  });

  it("replay：从失败 sequence 重放事件", async () => {
    const { tenantId, threadId, createdEvent } = await seedFullContext();

    // 先投影 thread.created（seq 1）
    await projectThreadEvent(createdEvent);

    // 插入 seq 2 事件（thread.model_changed，只需前移 cursor）
    const event2Id = await insertRawEvent(threadId, 2, "thread.model_changed", {
      model_id: "gpt-4",
    });
    const [event2] = await db
      .select()
      .from(v11ThreadEvent)
      .where(eq(v11ThreadEvent.id, event2Id))
      .limit(1);

    // 更新 stream floor latestSequence
    await updateEventStreamFloorLatest("thread_event", threadId, 2);

    // 创建一个 quarantined failure（seq 2）
    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: event2Id,
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await updateDeliveryFailureState(failure.id, "quarantined", {
      attemptCount: QUARANTINE_THRESHOLD,
    });

    // replay 处置
    const result = await resolveQuarantine({
      failureId: failure.id,
      resolution: "replay",
      actor: systemActor(tenantId),
      reason: "修复后重放",
    });

    expect(result.resolution).toBe("replay");
    expect(result.replayedCount).toBe(1); // seq 2 的事件被重放
    expect(result.failure.failureState).toBe("resolved");

    // checkpoint 应前移到 seq 2（由 projectThreadEvent 在重放时前移）
    const checkpoint = await getProjectionCheckpoint(
      "thread_list_projection",
      "thread_event",
      threadId,
    );
    expect(checkpoint?.lastSequence).toBe(2);
  });

  it("非 quarantined 状态拒绝处置", async () => {
    const { tenantId, threadId } = await seedFullContext();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    // 状态为 retrying（默认）

    await expect(
      resolveQuarantine({
        failureId: failure.id,
        resolution: "skip",
        actor: systemActor(tenantId),
      }),
    ).rejects.toThrow(/非 quarantined/);
  });

  it("不存在的 failure 抛错", async () => {
    const { tenantId } = await seedFullContext();

    await expect(
      resolveQuarantine({
        failureId: randomUUID(),
        resolution: "skip",
        actor: systemActor(tenantId),
      }),
    ).rejects.toThrow(/不存在/);
  });
});

// ─── listDeliveryFailures ─────────────────────────────

describe("listDeliveryFailures", () => {
  it("按 consumer_name 过滤", async () => {
    const { tenantId, threadId } = await seedFullContext();

    await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await recordDeliveryFailure({
      consumerName: "turn_timeline_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "sequence_gap",
    });

    const threadListFailures = await listDeliveryFailures(tenantId, {
      consumerName: "thread_list_projection",
    });
    expect(threadListFailures).toHaveLength(1);
    expect(threadListFailures[0]?.consumerName).toBe("thread_list_projection");

    const turnTimelineFailures = await listDeliveryFailures(tenantId, {
      consumerName: "turn_timeline_projection",
    });
    expect(turnTimelineFailures).toHaveLength(1);
    expect(turnTimelineFailures[0]?.consumerName).toBe("turn_timeline_projection");
  });

  it("按 failure_state 过滤", async () => {
    const { tenantId, threadId } = await seedFullContext();

    const f1 = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await updateDeliveryFailureState(f1.id, "quarantined", { attemptCount: 5 });

    await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 3,
      failureClass: "sequence_gap",
    });

    const quarantined = await listDeliveryFailures(tenantId, { failureState: "quarantined" });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.failureState).toBe("quarantined");

    const retrying = await listDeliveryFailures(tenantId, { failureState: "retrying" });
    expect(retrying).toHaveLength(1);
    expect(retrying[0]?.failureState).toBe("retrying");
  });

  it("按 stream_id 过滤", async () => {
    const { tenantId, threadId } = await seedFullContext();

    await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: randomUUID(), // 不同 streamId
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });

    // 第二个 failure 的 streamId 没有 stream floor，所以不会出现在结果中（inner join）
    const filtered = await listDeliveryFailures(tenantId, { streamId: threadId });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.streamId).toBe(threadId);
  });

  it("租户隔离：跨租户 failure 不可见", async () => {
    const { tenantId, threadId } = await seedFullContext();
    const otherTenantId = await seedSecondTenant();

    // 在默认租户创建 failure
    await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });

    // 用第二租户查询 → 应为空
    const otherTenantFailures = await listDeliveryFailures(otherTenantId);
    expect(otherTenantFailures).toHaveLength(0);

    // 用默认租户查询 → 应有 1 条
    const ownFailures = await listDeliveryFailures(tenantId);
    expect(ownFailures).toHaveLength(1);
  });
});

// ─── getDeliveryFailureById ───────────────────────────

describe("getDeliveryFailureById", () => {
  it("本租户内可查到", async () => {
    const { tenantId, threadId } = await seedFullContext();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });

    const found = await getDeliveryFailureById(tenantId, failure.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(failure.id);
  });

  it("跨租户返回 null", async () => {
    const { tenantId, threadId } = await seedFullContext();
    const otherTenantId = await seedSecondTenant();

    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });

    const found = await getDeliveryFailureById(otherTenantId, failure.id);
    expect(found).toBeNull();
  });

  it("不存在的 id 返回 null", async () => {
    const { tenantId } = await seedFullContext();
    const found = await getDeliveryFailureById(tenantId, randomUUID());
    expect(found).toBeNull();
  });
});

// ─── getProjectionLagForStream ────────────────────────

describe("getProjectionLagForStream", () => {
  it("正确计算 lag 和 quarantine 标记", async () => {
    const { tenantId, threadId, createdEvent } = await seedFullContext();

    // 投影 thread.created（seq 1）→ checkpoint 到 1
    await projectThreadEvent(createdEvent);

    // 更新 stream floor latestSequence = 3
    await updateEventStreamFloorLatest("thread_event", threadId, 3);

    // 创建 quarantined failure
    const failure = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await updateDeliveryFailureState(failure.id, "quarantined", { attemptCount: 5 });

    const lags = await getProjectionLagForStream(tenantId, "thread_event", threadId);

    // 两个 consumer：thread_list_projection 和 turn_timeline_projection
    // thread_list_projection: checkpoint=1, latestSequence=3, lag=2, hasQuarantine=true
    // turn_timeline_projection: 可能无 checkpoint（未投影），不在结果中
    const threadListLag = lags.find((l) => l.consumerName === "thread_list_projection");
    expect(threadListLag).toBeDefined();
    expect(threadListLag?.lastSequence).toBe(1);
    expect(threadListLag?.latestSequence).toBe(3);
    expect(threadListLag?.lag).toBe(2);
    expect(threadListLag?.hasQuarantine).toBe(true);
  });

  it("无 quarantine 时 hasQuarantine=false", async () => {
    const { tenantId, threadId, createdEvent } = await seedFullContext();

    await projectThreadEvent(createdEvent);
    await updateEventStreamFloorLatest("thread_event", threadId, 2);

    const lags = await getProjectionLagForStream(tenantId, "thread_event", threadId);
    const threadListLag = lags.find((l) => l.consumerName === "thread_list_projection");
    expect(threadListLag).toBeDefined();
    expect(threadListLag?.hasQuarantine).toBe(false);
    expect(threadListLag?.lag).toBe(1);
  });

  it("跨租户返回空数组", async () => {
    const { tenantId, threadId } = await seedFullContext();
    const otherTenantId = await seedSecondTenant();

    const lags = await getProjectionLagForStream(otherTenantId, "thread_event", threadId);
    expect(lags).toHaveLength(0);

    // 本租户可查到
    const ownLags = await getProjectionLagForStream(tenantId, "thread_event", threadId);
    // 无 checkpoint 时也可能为空，但 stream floor 存在
    // 这里只验证不抛错
    expect(Array.isArray(ownLags)).toBe(true);
  });
});

// ─── listQuarantinedFailures ──────────────────────────

describe("listQuarantinedFailures", () => {
  it("仅返回 quarantined 状态的 failure", async () => {
    const { tenantId, threadId } = await seedFullContext();

    // quarantined
    const f1 = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await updateDeliveryFailureState(f1.id, "quarantined", { attemptCount: 5 });

    // retrying
    await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 3,
      failureClass: "sequence_gap",
    });

    const quarantined = await listQuarantinedFailures(tenantId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.id).toBe(f1.id);
    expect(quarantined[0]?.failureState).toBe("quarantined");
  });

  it("租户隔离：跨租户 quarantined failure 不可见", async () => {
    const { tenantId, threadId } = await seedFullContext();
    const otherTenantId = await seedSecondTenant();

    const f1 = await recordDeliveryFailure({
      consumerName: "thread_list_projection",
      streamType: "thread_event",
      streamId: threadId,
      eventId: randomUUID(),
      eventSequence: 2,
      failureClass: "schema_unsupported",
    });
    await updateDeliveryFailureState(f1.id, "quarantined", { attemptCount: 5 });

    // 第二租户查询 → 空
    const otherQuarantined = await listQuarantinedFailures(otherTenantId);
    expect(otherQuarantined).toHaveLength(0);

    // 本租户查询 → 1 条
    const ownQuarantined = await listQuarantinedFailures(tenantId);
    expect(ownQuarantined).toHaveLength(1);
  });
});
