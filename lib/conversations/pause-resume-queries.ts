import { randomUUID } from "node:crypto";
import { TurnNotFoundError, TurnStateConflictError } from "@/lib/conversations/errors";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { lockExecutionRootForProductWrite } from "@/lib/executions/persistence/execution-ownership-store";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationCommandTable } from "@/lib/persistence/schema/executions";
import { eq } from "drizzle-orm";

export const USER_PAUSED_ERROR_CODE = "USER_PAUSED";

/**
 * 为用户暂停的 Turn 入队同一 Invocation 的 resume 命令。
 * Harness Loop 依据原 Invocation 的 durable action history 继续，不新建 Turn，
 * 也不把 Regenerate 伪装成继续。Runtime 确认前保持 waiting_user，避免失败时
 * 把界面错误推进为“执行中”。
 */
export async function requestPausedTurnResume(params: {
  tenantId: string;
  ownerUserId: string;
  turnId: string;
  idempotencyKey: string;
  correlationId?: string;
}) {
  const commandId = randomUUID();
  const now = new Date();

  return db.transaction(async (tx) => {
    // R04 §2「固定锁图」：执行根（Invocation → 活跃 Ownership）必须早于产品根（Turn/Thread）。
    // 旧顺序「Turn → Thread → 建命令（锁 Ownership）」与 Runtime 路径「锁 I/O → 写 Thread
    // 事件流」互为反向持锁，构成真实死锁环。这里先做不加锁定位读保留原错误优先级，
    // 锁完执行根后再 FOR UPDATE Turn → Thread 并复验。
    const [located] = await tx
      .select({
        id: turnTable.id,
        threadId: turnTable.threadId,
        turnState: turnTable.turnState,
        errorCode: turnTable.errorCode,
        activeInvocationId: turnTable.activeInvocationId,
      })
      .from(turnTable)
      .where(eq(turnTable.id, params.turnId))
      .limit(1);
    if (!located) throw new TurnNotFoundError(params.turnId);

    const [locatedThread] = await tx
      .select({
        id: threadTable.id,
        tenantId: threadTable.tenantId,
        ownerUserId: threadTable.ownerUserId,
      })
      .from(threadTable)
      .where(eq(threadTable.id, located.threadId))
      .limit(1);
    if (
      !locatedThread ||
      locatedThread.tenantId !== params.tenantId ||
      locatedThread.ownerUserId !== params.ownerUserId
    ) {
      throw new TurnNotFoundError(params.turnId);
    }
    if (
      located.turnState !== "waiting_user" ||
      located.errorCode !== USER_PAUSED_ERROR_CODE ||
      !located.activeInvocationId
    ) {
      throw new TurnStateConflictError(params.turnId, located.turnState, "resume_paused_turn");
    }

    // 1) 执行根。
    await lockExecutionRootForProductWrite(tx, params.tenantId, located.activeInvocationId);

    // 2) 产品根：Turn → Thread，并复验。
    const [turn] = await tx
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, params.turnId))
      .for("update")
      .limit(1);
    if (
      !turn ||
      turn.threadId !== located.threadId ||
      turn.activeInvocationId !== located.activeInvocationId
    ) {
      throw new TurnStateConflictError(
        params.turnId,
        turn?.turnState ?? located.turnState,
        "resume_paused_turn",
      );
    }
    if (
      turn.turnState !== "waiting_user" ||
      turn.errorCode !== USER_PAUSED_ERROR_CODE ||
      !turn.activeInvocationId
    ) {
      throw new TurnStateConflictError(params.turnId, turn.turnState, "resume_paused_turn");
    }

    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, turn.threadId))
      .for("update")
      .limit(1);
    if (
      !thread ||
      thread.tenantId !== params.tenantId ||
      thread.ownerUserId !== params.ownerUserId
    ) {
      throw new TurnNotFoundError(params.turnId);
    }

    const commandPayload = {
      resume_source: "user_pause",
      resume_payload: { source: "user_pause" },
    };
    await createInvocationCommandInTransaction(tx, {
      tenantId: params.tenantId,
      invocationId: turn.activeInvocationId,
      commandType: "resume",
      idempotencyKey: params.idempotencyKey,
      payloadJson: commandPayload,
      requestedByType: "user",
      requestedById: params.ownerUserId,
      commandId,
    });

    const sequence = await allocateEventSequences(tx, thread.id, 1);
    const event = await insertThreadEvent(tx, thread.id, sequence, {
      eventType: "turn.resume_requested",
      turnId: turn.id,
      invocationId: turn.activeInvocationId,
      actorType: "user",
      actorId: params.ownerUserId,
      payload: { command_id: commandId, source: "user_pause" },
      idempotencyKey: `${params.idempotencyKey}:resume-requested`,
      correlationId: params.correlationId,
    });

    return {
      turnId: turn.id,
      turnState: "waiting_user" as const,
      resumeState: "requested" as const,
      command: { id: commandId, commandState: "queued" as const },
      eventId: event.id,
    };
  });
}
