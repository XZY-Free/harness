import { ThreadNotFoundError, ThreadVersionConflictError } from "@/lib/conversations/errors";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * Thread 设置与主 Agent 变更仓储（事务性，同事务写 Event）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md （更新 Thread 默认设置）、（更换 Thread 主 Agent）
 * - docs/architecture/persistence.md （事务边界：当前状态更新和 Event 追加同事务）
 * - docs/contracts/event-catalog.json（thread.model_changed / thread.environment_changed / thread.primary_agent_changed）
 *
 * 职责：
 * - updateThreadSettingsWithEvents：事务内锁定 Thread → 乐观锁校验 → 更新默认设置 → 按 field 变化写对应 Event。
 * - changePrimaryAgentWithEvent：事务内锁定 Thread → 乐观锁校验 → 更新 primaryAgentId → 写 thread.primary_agent_changed Event。
 *
 * 关键约束：
 * - 当前状态更新与 Event 追加同事务（）。
 * - sequence 在锁定 Thread 行后原子递增（不用 max+1）。
 * - thread.model_changed / thread.environment_changed 事件 payload 包含投影上下文（new_value）。
 * - workspace_id 变化不写持久 Event（契约未定义 thread.workspace_changed）；只更新 Thread 行。
 * - 乐观锁失败抛 ThreadVersionConflictError（route 层映射 412 ETAG_MISMATCH）。
 */
import { db } from "@/lib/db/client";
import {
  type Thread,
  type ThreadEvent,
  type ThreadEventActorType,
  threadTable,
} from "@/lib/persistence/schema/conversation";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 设置更新结果。 */
export interface ThreadSettingsUpdateResult {
  thread: Thread;
  /** 实际写入的 ThreadEvent（按 sequence 升序；可能为空数组——无可变字段时不写 Event）。 */
  events: ThreadEvent[];
}

/**
 * 事务内更新 Thread 默认设置并写对应 Event。
 *
 * 事件规则（与 event-catalog.json 对齐）：
 * - default_model_ref 变化 → 写 thread.model_changed
 * - default_environment_definition_id 变化 → 写 thread.environment_changed
 * - default_workspace_id 变化 → 不写持久 Event（契约未定义 thread.workspace_changed）
 *
 * 乐观锁：expectedVersionNo 不匹配抛 ThreadVersionConflictError。
 *
 * @returns 更新后 Thread + 写入的 events（无可变字段时 events 为空，Thread.versionNo 也不递增）
 */
export async function updateThreadSettingsWithEvents(params: {
  tenantId: string;
  threadId: string;
  expectedVersionNo: number;
  updates: {
    defaultModelRef?: string | null;
    defaultWorkspaceId?: string | null;
    defaultEnvironmentDefinitionId?: string | null;
  };
  actorType: ThreadEventActorType;
  actorId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<ThreadSettingsUpdateResult> {
  return db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE 锁定 Thread 行
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (thread.versionNo !== params.expectedVersionNo) {
      throw new ThreadVersionConflictError(
        params.threadId,
        params.expectedVersionNo,
        thread.versionNo,
      );
    }

    // 2. 计算实际变更的字段
    const modelChanged =
      params.updates.defaultModelRef !== undefined &&
      params.updates.defaultModelRef !== thread.defaultModelRef;
    const envChanged =
      params.updates.defaultEnvironmentDefinitionId !== undefined &&
      params.updates.defaultEnvironmentDefinitionId !== thread.defaultEnvironmentDefinitionId;
    const workspaceChanged =
      params.updates.defaultWorkspaceId !== undefined &&
      params.updates.defaultWorkspaceId !== thread.defaultWorkspaceId;

    const hasEventToWrite = modelChanged || envChanged;
    const hasAnyChange = hasEventToWrite || workspaceChanged;

    if (!hasAnyChange) {
      // 无变更：不递增 versionNo，不写 Event
      return { thread, events: [] };
    }

    // 3. 分配 sequence 并写入 Event（仅 model/environment 变化写 Event）
    const events: ThreadEvent[] = [];
    if (hasEventToWrite) {
      const eventCount = (modelChanged ? 1 : 0) + (envChanged ? 1 : 0);
      const startSequence = await allocateEventSequences(tx, params.threadId, eventCount);
      let seqCursor = startSequence;

      if (modelChanged) {
        const newModelRef = params.updates.defaultModelRef ?? null;
        const event = await insertThreadEvent(tx, params.threadId, seqCursor, {
          eventType: "thread.model_changed",
          actorType: params.actorType,
          actorId: params.actorId,
          payload: {
            previous_model_ref: thread.defaultModelRef,
            new_model_ref: newModelRef,
          },
          idempotencyKey: params.idempotencyKey,
          correlationId: params.correlationId,
        });
        events.push(event);
        seqCursor += 1;
      }

      if (envChanged) {
        const newEnvId = params.updates.defaultEnvironmentDefinitionId ?? null;
        const event = await insertThreadEvent(tx, params.threadId, seqCursor, {
          eventType: "thread.environment_changed",
          actorType: params.actorType,
          actorId: params.actorId,
          payload: {
            previous_environment_definition_id: thread.defaultEnvironmentDefinitionId,
            new_environment_definition_id: newEnvId,
          },
          idempotencyKey: params.idempotencyKey,
          correlationId: params.correlationId,
        });
        events.push(event);
      }
    }

    // 4. 更新 Thread 行（设置字段 + versionNo 递增 + lastEventSequence 已在 allocateEventSequences 内更新）
    const setClause: Record<string, unknown> = {
      versionNo: thread.versionNo + 1,
      updatedAt: new Date(),
    };
    if (modelChanged) setClause.defaultModelRef = params.updates.defaultModelRef ?? null;
    if (envChanged) {
      setClause.defaultEnvironmentDefinitionId =
        params.updates.defaultEnvironmentDefinitionId ?? null;
    }
    if (workspaceChanged) {
      setClause.defaultWorkspaceId = params.updates.defaultWorkspaceId ?? null;
    }

    await tx.update(threadTable).set(setClause).where(eq(threadTable.id, params.threadId));

    // 5. 回读更新后 Thread
    const [updated] = await tx
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .limit(1);
    if (!updated) {
      throw new Error(`updateThreadSettingsWithEvents: Thread 行未找到（id=${params.threadId}）`);
    }

    return { thread: updated, events };
  });
}

/** 主 Agent 变更结果。 */
export interface ChangePrimaryAgentResult {
  thread: Thread;
  event: ThreadEvent;
}

/**
 * 事务内更换 Thread 主 Agent 并写 thread.primary_agent_changed Event。
 *
 * 约束（行 207）：员工主动调用即是显式确认。
 * 乐观锁：expectedVersionNo 不匹配抛 ThreadVersionConflictError。
 */
export async function changePrimaryAgentWithEvent(params: {
  tenantId: string;
  threadId: string;
  nextAgentId: string;
  expectedVersionNo: number;
  reason?: string;
  actorType: ThreadEventActorType;
  actorId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}): Promise<ChangePrimaryAgentResult> {
  return db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE 锁定 Thread 行
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.threadId)))
      .for("update")
      .limit(1);

    if (!thread) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (thread.versionNo !== params.expectedVersionNo) {
      throw new ThreadVersionConflictError(
        params.threadId,
        params.expectedVersionNo,
        thread.versionNo,
      );
    }

    // 2. 分配 sequence 并写 thread.primary_agent_changed Event
    const startSequence = await allocateEventSequences(tx, params.threadId, 1);
    const event = await insertThreadEvent(tx, params.threadId, startSequence, {
      eventType: "thread.primary_agent_changed",
      actorType: params.actorType,
      actorId: params.actorId,
      payload: {
        // 投影上下文（projector 的 projectToThreadList 需要 primary_agent_id 更新投影行）
        primary_agent_id: params.nextAgentId,
        previous_agent_id: thread.primaryAgentId,
        reason: params.reason ?? null,
      },
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    });

    // 3. 更新 Thread 行
    await tx
      .update(threadTable)
      .set({
        primaryAgentId: params.nextAgentId,
        versionNo: thread.versionNo + 1,
        updatedAt: new Date(),
      })
      .where(eq(threadTable.id, params.threadId));

    // 4. 回读更新后 Thread
    const [updated] = await tx
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, params.threadId))
      .limit(1);
    if (!updated) {
      throw new Error(`changePrimaryAgentWithEvent: Thread 行未找到（id=${params.threadId}）`);
    }

    return { thread: updated, event };
  });
}
