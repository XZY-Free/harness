import { randomUUID } from "node:crypto";
import { TurnNotFoundError, TurnStateConflictError } from "@/lib/conversations/errors";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
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
    const [turn] = await tx
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, params.turnId))
      .for("update")
      .limit(1);
    if (!turn) throw new TurnNotFoundError(params.turnId);

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
    if (
      turn.turnState !== "waiting_user" ||
      turn.errorCode !== USER_PAUSED_ERROR_CODE ||
      !turn.activeInvocationId
    ) {
      throw new TurnStateConflictError(params.turnId, turn.turnState, "resume_paused_turn");
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
